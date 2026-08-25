package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/BeUnicorn2026/voice-partition-back/internal/config"
	"github.com/BeUnicorn2026/voice-partition-back/internal/jobs"
	"github.com/BeUnicorn2026/voice-partition-back/internal/meetmap"
)

func TestMeetMapJobRunsAsynchronously(t *testing.T) {
	cfg := config.Config{OpenRouterModel: config.DefaultOpenRouterModel, AIAPIToken: "secret", MaximumBodyBytes: 1 << 20}
	manager := jobs.New(meetmap.NewOpenRouter("", "", config.DefaultOpenRouterModel, "", time.Second), 1, 4)
	defer manager.Close()
	handler := New(cfg, manager)
	body := `{"meetingId":"meeting-1","segments":[{"speaker":"민수","start":0,"end":2,"text":"어떻게 시작할까요?"},{"speaker":"지수","start":3,"end":5,"text":"작게 시작하는 입장입니다"}]}`
	request := httptest.NewRequest(http.MethodPost, "/api/ai/meetmap/jobs", bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Voice-Partition-Tenant", "org-1:user-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	var created struct {
		Job jobs.Job `json:"job"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		lookup := httptest.NewRequest(http.MethodGet, "/api/ai/meetmap/jobs/"+created.Job.ID, nil)
		lookup.Header.Set("Authorization", "Bearer secret")
		lookup.Header.Set("X-Voice-Partition-Tenant", "org-1:user-1")
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, lookup)
		var payload struct {
			Job jobs.Job `json:"job"`
		}
		if err := json.NewDecoder(result.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload.Job.Status == jobs.Succeeded {
			if payload.Job.Result == nil || payload.Job.Result.Source != "local" {
				t.Fatalf("unexpected completed job: %#v", payload.Job)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("job did not complete")
}

func TestMeetMapJobsRequireConfiguredToken(t *testing.T) {
	cfg := config.Config{AIAPIToken: "secret", MaximumBodyBytes: 1 << 20}
	manager := jobs.New(meetmap.NewOpenRouter("", "", config.DefaultOpenRouterModel, "", time.Second), 1, 1)
	defer manager.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/ai/meetmap/jobs", strings.NewReader(`{"segments":[]}`))
	response := httptest.NewRecorder()
	New(cfg, manager).ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.Code)
	}
}
