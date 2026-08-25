package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/BeUnicorn2026/voice-partition-back/internal/livemap"
)

const (
	maxAgendaItems     = 20
	maxAgendaItemRunes = 200
	maxTurnIDRunes     = 128
	maxSpeakerRunes    = 80
	maxTurnTextRunes   = 4000
	defaultSpeaker     = "화자"
)

type createLivemapSessionRequest struct {
	MeetingID string   `json:"meetingId"`
	Agenda    []string `json:"agenda"`
}

type appendLivemapTurnRequest struct {
	TurnID  string  `json:"turnId"`
	Speaker string  `json:"speaker"`
	Text    string  `json:"text"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
}

func (server *Server) createLivemapSession(response http.ResponseWriter, request *http.Request) {
	tenantKey := strings.TrimSpace(request.Header.Get("X-Voice-Partition-Tenant"))
	if tenantKey == "" {
		writeError(response, http.StatusBadRequest, "세션 소유자 정보가 필요합니다")
		return
	}
	var input createLivemapSessionRequest
	if !server.decodeBody(response, request, &input) {
		return
	}
	if len(input.Agenda) > maxAgendaItems {
		writeError(response, http.StatusBadRequest, "아젠다는 최대 20개까지 허용됩니다")
		return
	}
	agenda := make([]string, 0, len(input.Agenda))
	for _, item := range input.Agenda {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if len([]rune(item)) > maxAgendaItemRunes {
			writeError(response, http.StatusBadRequest, "아젠다 항목은 200자를 초과할 수 없습니다")
			return
		}
		agenda = append(agenda, item)
	}
	session, err := server.liveMgr.Create(tenantKey, strings.TrimSpace(input.MeetingID), agenda)
	if err != nil {
		if errors.Is(err, livemap.ErrSessionCapacity) {
			writeError(response, http.StatusTooManyRequests, "동시 세션 한도를 초과했습니다")
			return
		}
		writeError(response, http.StatusInternalServerError, "세션을 생성하지 못했습니다")
		return
	}
	writeJSON(response, http.StatusCreated, map[string]any{
		"session": map[string]any{"id": session.ID(), "status": livemap.StatusActive, "seq": 0},
	})
}

func (server *Server) appendLivemapTurn(response http.ResponseWriter, request *http.Request) {
	session, ok := server.lookupLivemapSession(request)
	if !ok {
		writeError(response, http.StatusNotFound, "세션을 찾지 못했습니다")
		return
	}
	var input appendLivemapTurnRequest
	if !server.decodeBody(response, request, &input) {
		return
	}
	turnID := strings.TrimSpace(input.TurnID)
	if turnID == "" || len([]rune(turnID)) > maxTurnIDRunes {
		writeError(response, http.StatusBadRequest, "turnId가 올바르지 않습니다")
		return
	}
	text := strings.TrimSpace(input.Text)
	if text == "" {
		writeError(response, http.StatusBadRequest, "text는 비어 있을 수 없습니다")
		return
	}
	text = truncateRunes(text, maxTurnTextRunes)
	speaker := strings.TrimSpace(input.Speaker)
	if speaker == "" {
		speaker = defaultSpeaker
	}
	if len([]rune(speaker)) > maxSpeakerRunes {
		writeError(response, http.StatusBadRequest, "speaker는 80자를 초과할 수 없습니다")
		return
	}
	if input.Start < 0 || input.End < 0 {
		writeError(response, http.StatusBadRequest, "start와 end는 0 이상이어야 합니다")
		return
	}
	result, err := session.Enqueue(turnID, speaker, text, input.Start, input.End)
	if err != nil {
		switch {
		case errors.Is(err, livemap.ErrFinalized):
			writeError(response, http.StatusConflict, "종료된 세션에는 턴을 추가할 수 없습니다")
		case errors.Is(err, livemap.ErrMailboxFull):
			writeError(response, http.StatusTooManyRequests, "세션 처리 대기열이 가득 찼습니다")
		default:
			writeError(response, http.StatusInternalServerError, "턴을 추가하지 못했습니다")
		}
		return
	}
	if result.Duplicate {
		writeJSON(response, http.StatusOK, map[string]any{"accepted": false, "duplicate": true})
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"accepted": true, "queued": result.Queued})
}

func (server *Server) getLivemapSession(response http.ResponseWriter, request *http.Request) {
	session, ok := server.lookupLivemapSession(request)
	if !ok {
		writeError(response, http.StatusNotFound, "세션을 찾지 못했습니다")
		return
	}
	sinceSeq := parseSinceSeq(request.URL.Query().Get("sinceSeq"))
	snapshot := session.Snapshot(sinceSeq)
	writeJSON(response, http.StatusOK, map[string]any{
		"session": map[string]any{
			"id":     snapshot.ID,
			"status": snapshot.Status,
			"seq":    snapshot.Seq,
			"resync": snapshot.Resync,
			"deltas": snapshot.Deltas,
			"result": snapshot.Result,
		},
	})
}

func (server *Server) finalizeLivemapSession(response http.ResponseWriter, request *http.Request) {
	session, ok := server.lookupLivemapSession(request)
	if !ok {
		writeError(response, http.StatusNotFound, "세션을 찾지 못했습니다")
		return
	}
	final := session.Finalize()
	writeJSON(response, http.StatusOK, map[string]any{
		"session": map[string]any{"id": final.ID, "status": final.Status, "seq": final.Seq},
		"result":  final.Result,
		"metrics": final.Metrics,
	})
}

func (server *Server) deleteLivemapSession(response http.ResponseWriter, request *http.Request) {
	tenantKey := strings.TrimSpace(request.Header.Get("X-Voice-Partition-Tenant"))
	if !server.liveMgr.Delete(request.PathValue("id"), tenantKey) {
		writeError(response, http.StatusNotFound, "세션을 찾지 못했습니다")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

// lookupLivemapSession resolves the path id under the request tenant, returning
// false (a 404 to the caller) for both unknown ids and tenant mismatches.
func (server *Server) lookupLivemapSession(request *http.Request) (*livemap.Session, bool) {
	tenantKey := strings.TrimSpace(request.Header.Get("X-Voice-Partition-Tenant"))
	return server.liveMgr.Get(request.PathValue("id"), tenantKey)
}

// decodeBody enforces the body cap and rejects unknown/trailing JSON, writing
// the appropriate error and returning false on failure.
func (server *Server) decodeBody(response http.ResponseWriter, request *http.Request, target any) bool {
	request.Body = http.MaxBytesReader(response, request.Body, server.config.MaximumBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		status := http.StatusBadRequest
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			status = http.StatusRequestEntityTooLarge
		}
		writeError(response, status, "요청 본문이 올바르지 않습니다")
		return false
	}
	if err := ensureEOF(decoder); err != nil {
		status := http.StatusBadRequest
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			status = http.StatusRequestEntityTooLarge
		}
		writeError(response, status, "요청 본문에는 JSON 객체 하나만 허용됩니다")
		return false
	}
	return true
}

func parseSinceSeq(raw string) int64 {
	value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

func truncateRunes(text string, limit int) string {
	if runes := []rune(text); len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}
