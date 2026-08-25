package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/BeUnicorn2026/voice-partition-back/internal/config"
	"github.com/BeUnicorn2026/voice-partition-back/internal/jobs"
	"github.com/BeUnicorn2026/voice-partition-back/internal/meetmap"
)

type Server struct {
	config config.Config
	jobs   *jobs.Manager
	mux    *http.ServeMux
}

func New(cfg config.Config, manager *jobs.Manager) http.Handler {
	server := &Server{config: cfg, jobs: manager, mux: http.NewServeMux()}
	server.mux.HandleFunc("GET /api/health/live", server.live)
	server.mux.HandleFunc("GET /api/health/ready", server.ready)
	server.mux.HandleFunc("GET /api/health", server.health)
	server.mux.HandleFunc("POST /api/ai/meetmap/jobs", server.createMeetMapJob)
	server.mux.HandleFunc("GET /api/ai/meetmap/jobs/{id}", server.getMeetMapJob)
	return server.middleware(server.mux)
}

func (server *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Referrer-Policy", "no-referrer")
		if server.config.PublicOrigin != "" && request.Header.Get("Origin") == server.config.PublicOrigin {
			response.Header().Set("Access-Control-Allow-Origin", server.config.PublicOrigin)
			response.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			response.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			response.Header().Set("Vary", "Origin")
		}
		if request.Method == http.MethodOptions {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.HasPrefix(request.URL.Path, "/api/ai/") && !server.authorized(request) {
			writeError(response, http.StatusUnauthorized, "AI API 인증이 필요합니다")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func (server *Server) authorized(request *http.Request) bool {
	if server.config.AIAPIToken == "" {
		return true
	}
	provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
	return len(provided) == len(server.config.AIAPIToken) && subtle.ConstantTimeCompare([]byte(provided), []byte(server.config.AIAPIToken)) == 1
}

func (server *Server) live(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "status": "live", "runtime": "go"})
}

func (server *Server) ready(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "status": "ready", "runtime": "go", "meetmap": true})
}

func (server *Server) health(response http.ResponseWriter, _ *http.Request) {
	mode := "local"
	if server.config.OpenRouterAPIKey != "" {
		mode = "openrouter"
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":       true,
		"runtime":  "go",
		"services": map[string]any{"meetmap": true, "llm": server.config.OpenRouterAPIKey != "", "llmMode": mode, "llmModel": server.config.OpenRouterModel},
	})
}

func (server *Server) createMeetMapJob(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, server.config.MaximumBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input meetmap.Request
	if err := decoder.Decode(&input); err != nil {
		status := http.StatusBadRequest
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			status = http.StatusRequestEntityTooLarge
		}
		writeError(response, status, "요청 본문이 올바르지 않습니다")
		return
	}
	if err := ensureEOF(decoder); err != nil {
		writeError(response, http.StatusBadRequest, "요청 본문에는 JSON 객체 하나만 허용됩니다")
		return
	}
	job, err := server.jobs.Submit(input)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "대기열") {
			status = http.StatusServiceUnavailable
		}
		writeError(response, status, err.Error())
		return
	}
	response.Header().Set("Location", fmt.Sprintf("/api/ai/meetmap/jobs/%s", job.ID))
	writeJSON(response, http.StatusAccepted, map[string]any{"job": job})
}

func (server *Server) getMeetMapJob(response http.ResponseWriter, request *http.Request) {
	job, ok := server.jobs.Get(request.PathValue("id"))
	if !ok {
		writeError(response, http.StatusNotFound, "분석 작업을 찾지 못했습니다")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"job": job})
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("additional JSON value")
	}
	return err
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func HTTPServer(address string, handler http.Handler) *http.Server {
	return &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 60 * time.Second}
}
