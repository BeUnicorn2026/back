package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/BeUnicorn2026/voice-partition-back/internal/config"
	"github.com/BeUnicorn2026/voice-partition-back/internal/livemap"
)

func livemapConfig() config.Config {
	return config.Config{AIAPIToken: "secret", MaximumBodyBytes: 1 << 20}
}

func newLivemapHandler(t *testing.T, opts livemap.ManagerOptions) (http.Handler, *livemap.Manager) {
	t.Helper()
	manager := livemap.NewManager(livemap.LocalCaller{}, opts)
	t.Cleanup(manager.Close)
	return New(livemapConfig(), nil, manager), manager
}

func doRequest(t *testing.T, handler http.Handler, method, path, tenant, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Buffer
	if body == "" {
		reader = bytes.NewBuffer(nil)
	} else {
		reader = bytes.NewBufferString(body)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Authorization", "Bearer secret")
	if tenant != "" {
		request.Header.Set("X-Voice-Partition-Tenant", tenant)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func createSession(t *testing.T, handler http.Handler, tenant string) string {
	t.Helper()
	response := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions", tenant, `{"meetingId":"m1","agenda":["인증 방식"]}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("create expected 201, got %d: %s", response.Code, response.Body.String())
	}
	var created struct {
		Session struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Seq    int64  `json:"seq"`
		} `json:"session"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Session.ID == "" || created.Session.Status != "active" || created.Session.Seq != 0 {
		t.Fatalf("unexpected create body: %+v", created.Session)
	}
	return created.Session.ID
}

func TestLivemapCreateAndTurnLifecycle(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	id := createSession(t, handler, "org-1:user-1")

	turn := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/turns", "org-1:user-1", `{"turnId":"turn-1","speaker":"민수","text":"인증 방식 결정합시다","start":0,"end":1}`)
	if turn.Code != http.StatusAccepted {
		t.Fatalf("turn expected 202, got %d: %s", turn.Code, turn.Body.String())
	}
	var accepted struct {
		Accepted bool `json:"accepted"`
		Queued   int  `json:"queued"`
	}
	if err := json.NewDecoder(turn.Body).Decode(&accepted); err != nil {
		t.Fatal(err)
	}
	if !accepted.Accepted {
		t.Fatalf("turn should be accepted: %+v", accepted)
	}

	// Duplicate turnId is ignored idempotently.
	dup := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/turns", "org-1:user-1", `{"turnId":"turn-1","text":"같은 턴"}`)
	if dup.Code != http.StatusOK {
		t.Fatalf("duplicate turn expected 200, got %d", dup.Code)
	}
	var duplicate struct {
		Accepted  bool `json:"accepted"`
		Duplicate bool `json:"duplicate"`
	}
	if err := json.NewDecoder(dup.Body).Decode(&duplicate); err != nil {
		t.Fatal(err)
	}
	if duplicate.Accepted || !duplicate.Duplicate {
		t.Fatalf("expected duplicate ignore, got %+v", duplicate)
	}
}

func TestLivemapFinalizeIsIdempotent(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	id := createSession(t, handler, "t")
	doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/turns", "t", `{"turnId":"a","text":"인증 방식 결정합시다"}`)

	first := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/finalize", "t", "")
	if first.Code != http.StatusOK {
		t.Fatalf("finalize expected 200, got %d: %s", first.Code, first.Body.String())
	}
	var firstBody struct {
		Session struct {
			Status string `json:"status"`
			Seq    int64  `json:"seq"`
		} `json:"session"`
		Metrics map[string]any `json:"metrics"`
	}
	if err := json.NewDecoder(first.Body).Decode(&firstBody); err != nil {
		t.Fatal(err)
	}
	if firstBody.Session.Status != "finalized" || firstBody.Metrics == nil {
		t.Fatalf("finalize body missing status/metrics: %+v", firstBody)
	}

	second := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/finalize", "t", "")
	if second.Code != http.StatusOK {
		t.Fatalf("repeat finalize expected 200, got %d", second.Code)
	}
	var secondBody struct {
		Session struct {
			Seq int64 `json:"seq"`
		} `json:"session"`
	}
	if err := json.NewDecoder(second.Body).Decode(&secondBody); err != nil {
		t.Fatal(err)
	}
	if firstBody.Session.Seq != secondBody.Session.Seq {
		t.Fatalf("finalize not idempotent: %d vs %d", firstBody.Session.Seq, secondBody.Session.Seq)
	}
}

func TestLivemapGetReturnsDeltasAndResult(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	id := createSession(t, handler, "t")
	doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/turns", "t", `{"turnId":"a","text":"인증 방식 결정합시다"}`)
	// Finalize to deterministically drain before reading.
	doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/finalize", "t", "")

	get := doRequest(t, handler, http.MethodGet, "/api/ai/livemap/sessions/"+id+"?sinceSeq=0", "t", "")
	if get.Code != http.StatusOK {
		t.Fatalf("get expected 200, got %d", get.Code)
	}
	var payload struct {
		Session struct {
			Status string           `json:"status"`
			Seq    int64            `json:"seq"`
			Resync bool             `json:"resync"`
			Deltas []map[string]any `json:"deltas"`
			Result map[string]any   `json:"result"`
		} `json:"session"`
	}
	if err := json.NewDecoder(get.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.Status != "finalized" || payload.Session.Seq == 0 {
		t.Fatalf("unexpected session view: %+v", payload.Session)
	}
	if len(payload.Session.Deltas) == 0 || payload.Session.Result == nil {
		t.Fatalf("expected deltas and result, got %+v", payload.Session)
	}
}

func TestLivemapGetResyncForStaleCursor(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{MaxEvents: 1})
	id := createSession(t, handler, "t")
	doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/turns", "t", `{"turnId":"a","text":"인증 방식 결정합시다"}`)
	doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/finalize", "t", "")

	get := doRequest(t, handler, http.MethodGet, "/api/ai/livemap/sessions/"+id+"?sinceSeq=0", "t", "")
	var payload struct {
		Session struct {
			Resync bool             `json:"resync"`
			Deltas []map[string]any `json:"deltas"`
			Result map[string]any   `json:"result"`
		} `json:"session"`
	}
	if err := json.NewDecoder(get.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Session.Resync || len(payload.Session.Deltas) != 0 {
		t.Fatalf("stale cursor should resync with empty deltas: %+v", payload.Session)
	}
	if payload.Session.Result == nil {
		t.Fatal("resync response must still include the result")
	}
}

func TestLivemapTenantIsolationReturns404(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	id := createSession(t, handler, "tenant-A")
	get := doRequest(t, handler, http.MethodGet, "/api/ai/livemap/sessions/"+id, "tenant-B", "")
	if get.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant GET must be 404 (no existence leak), got %d", get.Code)
	}
	del := doRequest(t, handler, http.MethodDelete, "/api/ai/livemap/sessions/"+id, "tenant-B", "")
	if del.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant DELETE must be 404, got %d", del.Code)
	}
}

func TestLivemapDeleteReturns204(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	id := createSession(t, handler, "t")
	del := doRequest(t, handler, http.MethodDelete, "/api/ai/livemap/sessions/"+id, "t", "")
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete expected 204, got %d", del.Code)
	}
	// Subsequent access is a 404.
	get := doRequest(t, handler, http.MethodGet, "/api/ai/livemap/sessions/"+id, "t", "")
	if get.Code != http.StatusNotFound {
		t.Fatalf("deleted session GET must be 404, got %d", get.Code)
	}
}

func TestLivemapUnknownFieldRejected(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	response := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions", "t", `{"meetingId":"m","bogus":true}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field must be rejected with 400, got %d", response.Code)
	}
}

func TestLivemapSessionCapacityReturns429(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{MaxSessions: 1})
	createSession(t, handler, "t")
	second := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions", "t", `{}`)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("session cap must return 429, got %d: %s", second.Code, second.Body.String())
	}
}

func TestLivemapTurnToFinalizedSessionReturns409(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	id := createSession(t, handler, "t")
	doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/finalize", "t", "")
	turn := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/turns", "t", `{"turnId":"late","text":"늦은 턴"}`)
	if turn.Code != http.StatusConflict {
		t.Fatalf("turn to finalized session must be 409, got %d", turn.Code)
	}
}

func TestLivemapRejectsOutOfRangeTurnFields(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	id := createSession(t, handler, "t")
	tests := []struct {
		name string
		body string
	}{
		{name: "negative start", body: `{"turnId":"a","text":"내용","start":-1,"end":0}`},
		{name: "negative end", body: `{"turnId":"b","text":"내용","start":0,"end":-1}`},
		{name: "long speaker", body: `{"turnId":"c","speaker":"` + strings.Repeat("가", maxSpeakerRunes+1) + `","text":"내용"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions/"+id+"/turns", "t", test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestLivemapRejectsLongAgendaItem(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	body := `{"agenda":["` + strings.Repeat("가", maxAgendaItemRunes+1) + `"]}`
	response := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions", "t", body)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("long agenda item must be rejected with 400, got %d", response.Code)
	}
}

func TestLivemapCreateRequiresTenant(t *testing.T) {
	handler, _ := newLivemapHandler(t, livemap.ManagerOptions{})
	response := doRequest(t, handler, http.MethodPost, "/api/ai/livemap/sessions", "", `{}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("missing tenant must be 400, got %d", response.Code)
	}
}

func TestLivemapJSONPostRoutesRejectBodiesOverAbsoluteOneMiB(t *testing.T) {
	cfg := config.Config{AIAPIToken: "secret", MaximumBodyBytes: config.MaximumAIRequestBytes * 8}
	manager := livemap.NewManager(livemap.LocalCaller{}, livemap.ManagerOptions{})
	t.Cleanup(manager.Close)
	handler := New(cfg, nil, manager)
	id := createSession(t, handler, "t")
	oversized := `{"padding":"` + strings.Repeat("x", int(config.MaximumAIRequestBytes)) + `"}`
	for _, path := range []string{
		"/api/ai/livemap/sessions",
		"/api/ai/livemap/sessions/" + id + "/turns",
	} {
		t.Run(path, func(t *testing.T) {
			response := doRequest(t, handler, http.MethodPost, path, "t", oversized)
			if response.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("oversized body must return 413, got %d: %s", response.Code, response.Body.String())
			}
		})
	}
}
