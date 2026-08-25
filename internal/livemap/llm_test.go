package livemap

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewCallerLocalFallbackWhenNoKey(t *testing.T) {
	caller := NewCaller("", "https://openrouter.ai/api/v1", "model", "")
	if _, ok := caller.(LocalCaller); !ok {
		t.Fatalf("expected LocalCaller with no API key, got %T", caller)
	}
	state := NewState()
	turn := Turn{Text: "인증 방식을 어떻게 정할까요?", SegmentIndex: 0}
	result, err := caller.CallA(context.Background(), "ignored", state, turn)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Nodes) == 0 {
		t.Fatal("local fallback Call A should produce a node for a substantive turn")
	}
}

func TestNewCallerUsesOpenRouterWithKey(t *testing.T) {
	if _, ok := NewCaller("key", "https://openrouter.ai/api/v1", "model", "").(*OpenRouterCaller); !ok {
		t.Fatal("expected OpenRouterCaller when an API key is set")
	}
}

func TestOpenRouterCallARetriesOnceAfter429(t *testing.T) {
	var (
		mu     sync.Mutex
		calls  int
		bodies [][]byte
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		calls++
		attempt := calls
		bodies = append(bodies, raw)
		mu.Unlock()
		if attempt == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"rate limited"}`))
			return
		}
		content := `{"topic":{"is_new":true,"title":"인증 방식","off_agenda":false},"nodes":[]}`
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": content}}},
		})
	}))
	defer server.Close()

	caller := NewOpenRouterCaller("secret", server.URL, "test-model", "https://example.test")
	caller.retryWait = func(context.Context) error { return nil } // no backoff latency in tests

	const userMessage = "CALL_A_TURN_DATA_V1\n@end\n"
	result, err := caller.CallA(context.Background(), userMessage, nil, Turn{})
	if err != nil {
		t.Fatalf("CallA should succeed after one retry: %v", err)
	}
	if !result.Topic.IsNew || result.Topic.Title != "인증 방식" {
		t.Fatalf("unexpected decoded result: %+v", result.Topic)
	}

	mu.Lock()
	defer mu.Unlock()
	if calls != 2 {
		t.Fatalf("expected exactly one retry (2 calls), got %d", calls)
	}

	var payload map[string]any
	if err := json.Unmarshal(bodies[0], &payload); err != nil {
		t.Fatal(err)
	}
	// (b) No temperature field must be sent.
	if _, present := payload["temperature"]; present {
		t.Fatal("temperature must not be present in the request body")
	}
	// (a) Strict json_schema with the correct schema name.
	responseFormat, _ := payload["response_format"].(map[string]any)
	jsonSchema, _ := responseFormat["json_schema"].(map[string]any)
	if jsonSchema["name"] != SchemaAName {
		t.Fatalf("json_schema name = %v, want %s", jsonSchema["name"], SchemaAName)
	}
	if jsonSchema["strict"] != true {
		t.Fatalf("json_schema strict must be true, got %v", jsonSchema["strict"])
	}
	if _, ok := jsonSchema["schema"].(map[string]any); !ok {
		t.Fatalf("json_schema schema must be an object, got %T", jsonSchema["schema"])
	}
	if payload["model"] != "test-model" {
		t.Fatalf("model = %v, want test-model", payload["model"])
	}
	if payload["max_tokens"] != float64(callAMaxTokens) {
		t.Fatalf("max_tokens = %v, want %d", payload["max_tokens"], callAMaxTokens)
	}
	provider, _ := payload["provider"].(map[string]any)
	if len(provider) != 1 || provider["require_parameters"] != true {
		t.Fatalf("unexpected provider contract: %#v", provider)
	}
	reasoning, _ := payload["reasoning"].(map[string]any)
	if len(reasoning) != 1 || reasoning["effort"] != "low" {
		t.Fatalf("unexpected reasoning contract: %#v", reasoning)
	}
	// (c) System/user split with static prompt in system, variable data in user.
	messages, _ := payload["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}
	systemMessage, _ := messages[0].(map[string]any)
	if systemMessage["role"] != "system" || systemMessage["content"] != SystemPromptA {
		t.Fatalf("first message must carry the static system prompt: %+v", systemMessage)
	}
	userMessageBody, _ := messages[1].(map[string]any)
	if userMessageBody["role"] != "user" || userMessageBody["content"] != userMessage {
		t.Fatalf("second message must carry the variable user data: %+v", userMessageBody)
	}
}

func TestOpenRouterCallARetriesSchemaShapeMismatch(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		content := `{}`
		if calls == 2 {
			content = `{"topic":{"is_new":false,"title":"인증","off_agenda":false},"nodes":[]}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": content}}},
		})
	}))
	defer server.Close()

	caller := NewOpenRouterCaller("secret", server.URL, "test-model", "")
	caller.retryWait = func(context.Context) error { return nil }
	if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); err != nil {
		t.Fatalf("Call A should retry a missing required field: %v", err)
	}
	if calls != 2 {
		t.Fatalf("schema mismatch should get exactly one retry, got %d calls", calls)
	}
}

func TestOpenRouterAcceptsCaseVariantsForP1Normalization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		content := `{"topic":{"is_new":true,"title":"인증","off_agenda":false},"nodes":[{"type":"QUESTION","text":"질문","quote":"질문","terms":[]}]}`
		if strings.Contains(r.URL.Path, "unused") {
			t.Fatal("unexpected path")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": content}}}})
	}))
	defer server.Close()
	caller := NewOpenRouterCaller("secret", server.URL, "model", "")
	caller.retryWait = func(context.Context) error { return nil }
	if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); err != nil {
		t.Fatalf("case variant should reach P1 normalizer: %v", err)
	}
}

func TestOpenRouterRetriesTrailingEnvelopeJSON(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		content := `{"topic":{"is_new":false,"title":"인증","off_agenda":false},"nodes":[]}`
		payload, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": content}}}})
		_, _ = w.Write(payload)
		if calls == 1 {
			_, _ = w.Write([]byte(` {}`))
		}
	}))
	defer server.Close()
	caller := NewOpenRouterCaller("secret", server.URL, "model", "")
	caller.retryWait = func(context.Context) error { return nil }
	if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); err != nil {
		t.Fatalf("valid second envelope should succeed: %v", err)
	}
	if calls != 2 {
		t.Fatalf("trailing envelope JSON should cause exactly one retry, got %d calls", calls)
	}
}

func TestOpenRouterCallAStopsAfterOneDecodeRetry(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": "not json"}}},
		})
	}))
	defer server.Close()

	caller := NewOpenRouterCaller("secret", server.URL, "test-model", "")
	caller.retryWait = func(context.Context) error { return nil }
	if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); err == nil {
		t.Fatal("Call A should fail after its single decode retry")
	}
	if calls != 2 {
		t.Fatalf("decode failure should make exactly 2 total attempts, got %d", calls)
	}
}

func TestOpenRouterCallBSendsSchemaBName(t *testing.T) {
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		content := `{"parent_id":"n01","relation":"answers","confidence":0.9,"reason":"근거"}`
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": content}}},
		})
	}))
	defer server.Close()

	caller := NewOpenRouterCaller("secret", server.URL, "test-model", "")
	caller.retryWait = func(context.Context) error { return nil }
	result, err := caller.CallB(context.Background(), "CALL_B_NODE_DATA_V1\n@end\n", nil, &Node{})
	if err != nil {
		t.Fatalf("CallB should succeed: %v", err)
	}
	if result.ParentID == nil || *result.ParentID != "n01" || result.Relation == nil || *result.Relation != "answers" {
		t.Fatalf("unexpected Call B result: %+v", result)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if _, present := payload["temperature"]; present {
		t.Fatal("temperature must not be present for Call B")
	}
	responseFormat, _ := payload["response_format"].(map[string]any)
	jsonSchema, _ := responseFormat["json_schema"].(map[string]any)
	if jsonSchema["name"] != SchemaBName || jsonSchema["strict"] != true {
		t.Fatalf("unexpected Call B schema contract: %#v", jsonSchema)
	}
	if payload["model"] != "test-model" || payload["max_tokens"] != float64(callBMaxTokens) {
		t.Fatalf("unexpected Call B model/token contract: model=%v max_tokens=%v", payload["model"], payload["max_tokens"])
	}
	provider, _ := payload["provider"].(map[string]any)
	reasoning, _ := payload["reasoning"].(map[string]any)
	if provider["require_parameters"] != true || reasoning["effort"] != "low" {
		t.Fatalf("unexpected Call B provider/reasoning contract: provider=%#v reasoning=%#v", provider, reasoning)
	}
	messages, _ := payload["messages"].([]any)
	if len(messages) != 2 || messages[0].(map[string]any)["role"] != "system" || messages[0].(map[string]any)["content"] != SystemPromptB || messages[1].(map[string]any)["role"] != "user" {
		t.Fatalf("unexpected Call B messages: %#v", messages)
	}
}

func TestOpenRouterCallARetries5xxAndEnvelopeDecode(t *testing.T) {
	tests := []struct {
		name  string
		first func(http.ResponseWriter)
	}{
		{name: "5xx", first: func(w http.ResponseWriter) { http.Error(w, "failed", http.StatusBadGateway) }},
		{name: "decode", first: func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{`) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if calls.Add(1) == 1 {
					test.first(w)
					return
				}
				content := `{"topic":{"is_new":false,"title":"인증","off_agenda":false},"nodes":[]}`
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []map[string]any{{"message": map[string]any{"content": content}}}})
			}))
			defer server.Close()
			caller := NewOpenRouterCaller("secret", server.URL, "stealth/ox-alpha", "")
			caller.retryWait = func(context.Context) error { return nil }
			if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); err != nil {
				t.Fatalf("expected retry success: %v", err)
			}
			if calls.Load() != 2 {
				t.Fatalf("expected exactly two calls, got %d", calls.Load())
			}
		})
	}
}

func TestOpenRouterCallADoesNotRetry4xx(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "bad request", http.StatusUnprocessableEntity)
	}))
	defer server.Close()
	caller := NewOpenRouterCaller("secret", server.URL, "stealth/ox-alpha", "")
	var waits atomic.Int32
	caller.retryWait = func(context.Context) error { waits.Add(1); return nil }
	if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); err == nil {
		t.Fatal("expected nonretryable 4xx error")
	}
	if calls.Load() != 1 || waits.Load() != 0 {
		t.Fatalf("4xx retried: calls=%d waits=%d", calls.Load(), waits.Load())
	}
}

func TestOpenRouterCallAExhaustionSurfacesWithoutLocalFallback(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "ox alpha unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	caller := NewOpenRouterCaller("configured-key", server.URL, "stealth/ox-alpha", "")
	caller.retryWait = func(context.Context) error { return nil }
	result, err := caller.CallA(context.Background(), "message", NewState(), Turn{Text: "로컬이면 노드가 생길 내용"})
	if err == nil || len(result.Nodes) != 0 || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("provider exhaustion must surface: result=%#v err=%v", result, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("expected two provider attempts, got %d", calls.Load())
	}
}

func TestOpenRouterCallACancellationAbortsBackoff(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer server.Close()
	caller := NewOpenRouterCaller("secret", server.URL, "stealth/ox-alpha", "")
	ctx, cancel := context.WithCancel(context.Background())
	caller.retryWait = func(waitCtx context.Context) error {
		cancel()
		<-waitCtx.Done()
		return waitCtx.Err()
	}
	_, err := caller.CallA(ctx, "message", nil, Turn{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation during backoff, got %v", err)
	}
}

func TestOpenRouterCallADeadlineCancelsRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	caller := NewOpenRouterCaller("secret", server.URL, "stealth/ox-alpha", "")
	caller.CallATimeout = 20 * time.Millisecond
	if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected call deadline, got %v", err)
	}
}

func TestOpenRouterCallARetriesOversizedEnvelopeOnce(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, strings.Repeat(" ", (4<<20)+1)+`{}`)
	}))
	defer server.Close()
	caller := NewOpenRouterCaller("secret", server.URL, "stealth/ox-alpha", "")
	caller.CallATimeout = 2 * time.Second
	caller.retryWait = func(context.Context) error { return nil }
	if _, err := caller.CallA(context.Background(), "message", nil, Turn{}); err == nil {
		t.Fatal("oversized envelope must fail")
	}
	if calls.Load() != 2 {
		t.Fatalf("oversized envelope should get one retry, got %d calls", calls.Load())
	}
}
