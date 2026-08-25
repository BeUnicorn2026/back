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
	"github.com/BeUnicorn2026/voice-partition-back/internal/livemap"
	"github.com/BeUnicorn2026/voice-partition-back/internal/meetmap"
)

type Server struct {
	config  config.Config
	jobs    *jobs.Manager
	liveMgr *livemap.Manager
	mux     *http.ServeMux
}

func New(cfg config.Config, manager *jobs.Manager, live *livemap.Manager) http.Handler {
	cfg.MaximumBodyBytes = effectiveMaximumBodyBytes(cfg.MaximumBodyBytes)
	server := &Server{config: cfg, jobs: manager, liveMgr: live, mux: http.NewServeMux()}
	server.mux.HandleFunc("GET /api/health/live", server.live)
	server.mux.HandleFunc("GET /api/health/ready", server.ready)
	server.mux.HandleFunc("GET /api/health", server.health)
	server.mux.HandleFunc("POST /api/ai/meetmap/jobs", server.createMeetMapJob)
	server.mux.HandleFunc("GET /api/ai/meetmap/jobs/{id}", server.getMeetMapJob)
	if live != nil {
		server.mux.HandleFunc("POST /api/ai/livemap/sessions", server.createLivemapSession)
		server.mux.HandleFunc("POST /api/ai/livemap/sessions/{id}/turns", server.appendLivemapTurn)
		server.mux.HandleFunc("GET /api/ai/livemap/sessions/{id}", server.getLivemapSession)
		server.mux.HandleFunc("POST /api/ai/livemap/sessions/{id}/finalize", server.finalizeLivemapSession)
		server.mux.HandleFunc("DELETE /api/ai/livemap/sessions/{id}", server.deleteLivemapSession)
	}
	return server.middleware(server.mux)
}

func (server *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Referrer-Policy", "no-referrer")
		if server.config.PublicOrigin != "" && request.Header.Get("Origin") == server.config.PublicOrigin {
			response.Header().Set("Access-Control-Allow-Origin", server.config.PublicOrigin)
			response.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Voice-Partition-Tenant")
			response.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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
		return false
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
	tenantKey := strings.TrimSpace(request.Header.Get("X-Voice-Partition-Tenant"))
	if tenantKey == "" {
		writeError(response, http.StatusBadRequest, "분석 작업 소유자 정보가 필요합니다")
		return
	}
	var input meetmap.Request
	if !server.decodeBody(response, request, &input) {
		return
	}
	input.TenantKey = tenantKey
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
	job, ok := server.jobs.Get(request.PathValue("id"), strings.TrimSpace(request.Header.Get("X-Voice-Partition-Tenant")))
	if !ok {
		writeError(response, http.StatusNotFound, "분석 작업을 찾지 못했습니다")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"job": job})
}

func effectiveMaximumBodyBytes(configured int64) int64 {
	if configured <= 0 || configured > config.MaximumAIRequestBytes {
		return config.MaximumAIRequestBytes
	}
	return configured
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
