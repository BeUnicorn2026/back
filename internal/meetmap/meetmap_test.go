package meetmap

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func exampleSegments() []Segment {
	return []Segment{
		{Speaker: "민수", Start: 0, End: 3, Text: "출시 범위를 어디까지 정할까요?"},
		{Speaker: "지수", Start: 4, End: 8, Text: "모바일 기능부터 출시하는 입장입니다"},
		{Speaker: "민수", Start: 9, End: 12, Text: "일정을 줄이는 데 도움이 됩니다"},
		{Speaker: "지수", Start: 13, End: 16, Text: "결제 안정성이 부족할 수 있습니다"},
	}
}

func TestLocalMeetMapFollowsDialogueConstraints(t *testing.T) {
	result := Local(exampleSegments())
	if err := Validate(result, len(exampleSegments())); err != nil {
		t.Fatal(err)
	}
	if result.Source != "local" || len(result.Topics) != 1 || len(result.Topics[0].Nodes) != 4 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.Topics[0].Nodes[0].Kind != "question" || result.Topics[0].Nodes[1].Kind != "position" {
		t.Fatalf("unexpected tags: %#v", result.Topics[0].Nodes)
	}
}

func TestValidationRejectsDuplicateTranscriptEvidence(t *testing.T) {
	result := Local(exampleSegments())
	result.Topics[0].Nodes[1].SegmentIndex = result.Topics[0].Nodes[0].SegmentIndex
	if err := Validate(result, len(exampleSegments())); err == nil {
		t.Fatal("expected duplicate evidence to be rejected")
	}
}

func validMeetMapEnvelope(t *testing.T) string {
	t.Helper()
	generated := Local(exampleSegments())
	content, err := json.Marshal(map[string]any{"topics": generated.Topics})
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(content)}}}})
	if err != nil {
		t.Fatal(err)
	}
	return string(envelope)
}

func assertRequired(t *testing.T, schema map[string]any, want ...string) {
	t.Helper()
	gotValues, ok := schema["required"].([]any)
	if !ok {
		t.Fatalf("required is not an array: %#v", schema["required"])
	}
	got := make(map[string]bool, len(gotValues))
	for _, value := range gotValues {
		got[value.(string)] = true
	}
	if len(got) != len(want) {
		t.Fatalf("unexpected required fields: %#v", gotValues)
	}
	for _, field := range want {
		if !got[field] {
			t.Fatalf("required field %q missing from %#v", field, gotValues)
		}
	}
}

func TestOpenRouterUsesExactContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("missing bearer token")
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "stealth/ox-alpha" {
			t.Fatalf("unexpected model: %v", body["model"])
		}
		if _, present := body["temperature"]; present {
			t.Fatal("temperature must not be present")
		}
		if body["max_tokens"] != float64(5000) {
			t.Fatalf("max_tokens = %v, want 5000", body["max_tokens"])
		}
		provider, ok := body["provider"].(map[string]any)
		if !ok || len(provider) != 1 || provider["require_parameters"] != true {
			t.Fatalf("unexpected provider contract: %#v", body["provider"])
		}
		reasoning, ok := body["reasoning"].(map[string]any)
		if !ok || len(reasoning) != 1 || reasoning["effort"] != "low" {
			t.Fatalf("unexpected reasoning contract: %#v", body["reasoning"])
		}
		messages, ok := body["messages"].([]any)
		if !ok || len(messages) != 2 {
			t.Fatalf("expected system and user messages: %#v", body["messages"])
		}
		system := messages[0].(map[string]any)
		user := messages[1].(map[string]any)
		if system["role"] != "system" || system["content"] != systemPrompt {
			t.Fatalf("unexpected system message: %#v", system)
		}
		if user["role"] != "user" || !strings.Contains(user["content"].(string), `"transcript"`) {
			t.Fatalf("unexpected user message: %#v", user)
		}
		format := body["response_format"].(map[string]any)
		if format["type"] != "json_schema" {
			t.Fatalf("unexpected response format: %#v", format)
		}
		jsonSchema := format["json_schema"].(map[string]any)
		if jsonSchema["name"] != "meetmap_result" || jsonSchema["strict"] != true {
			t.Fatalf("unexpected JSON schema config: %#v", jsonSchema)
		}
		schema := jsonSchema["schema"].(map[string]any)
		if schema["additionalProperties"] != false {
			t.Fatalf("root schema must reject additional properties: %#v", schema)
		}
		assertRequired(t, schema, "topics")
		topic := schema["properties"].(map[string]any)["topics"].(map[string]any)["items"].(map[string]any)
		if topic["additionalProperties"] != false {
			t.Fatalf("topic schema must reject additional properties: %#v", topic)
		}
		assertRequired(t, topic, "id", "label", "nodes")
		node := topic["properties"].(map[string]any)["nodes"].(map[string]any)["items"].(map[string]any)
		if node["additionalProperties"] != false {
			t.Fatalf("node schema must reject additional properties: %#v", node)
		}
		assertRequired(t, node, "id", "segmentIndex", "kind", "summary", "parentId", "relation")
		kind := node["properties"].(map[string]any)["kind"].(map[string]any)
		wantKinds := []any{"question", "position", "pro", "con"}
		gotKinds := kind["enum"].([]any)
		if len(gotKinds) != len(wantKinds) || gotKinds[0] != wantKinds[0] || gotKinds[1] != wantKinds[1] || gotKinds[2] != wantKinds[2] || gotKinds[3] != wantKinds[3] {
			t.Fatalf("unexpected kind enum: %#v", gotKinds)
		}
		_, _ = io.WriteString(response, validMeetMapEnvelope(t))
	}))
	defer server.Close()

	client := NewOpenRouter("test-key", server.URL, "stealth/ox-alpha", "", 2*time.Second)
	result, err := client.Analyze(context.Background(), exampleSegments())
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "openrouter" || result.Model != "stealth/ox-alpha" {
		t.Fatalf("unexpected provider result: %#v", result)
	}
}

func TestOpenRouterKeylessModeIsExplicitlyLocal(t *testing.T) {
	client := NewOpenRouter("", "http://127.0.0.1:1", "stealth/ox-alpha", "", time.Millisecond)
	result, err := client.Analyze(context.Background(), exampleSegments())
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "local" || result.Model != "" {
		t.Fatalf("keyless analysis must be local: %#v", result)
	}
}

func TestOpenRouterRetriesRetryableFailuresOnce(t *testing.T) {
	tests := []struct {
		name  string
		first func(http.ResponseWriter)
	}{
		{name: "429", first: func(w http.ResponseWriter) { http.Error(w, "rate limited", http.StatusTooManyRequests) }},
		{name: "500", first: func(w http.ResponseWriter) { http.Error(w, "provider failed", http.StatusInternalServerError) }},
		{name: "envelope decode", first: func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{`) }},
		{name: "content decode", first: func(w http.ResponseWriter) {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"not JSON"}}]}`)
		}},
		{name: "schema validation", first: func(w http.ResponseWriter) {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{\\"topics\\":[]}"}}]}`)
		}},
		{name: "empty choices", first: func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{"choices":[]}`) }},
		{name: "trailing envelope", first: func(w http.ResponseWriter) { _, _ = io.WriteString(w, validMeetMapEnvelope(t)+` {}`) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				if requests.Add(1) == 1 {
					test.first(response)
					return
				}
				_, _ = io.WriteString(response, validMeetMapEnvelope(t))
			}))
			defer server.Close()

			client := NewOpenRouter("test-key", server.URL, "stealth/ox-alpha", "", 2*time.Second)
			var waits atomic.Int32
			client.retryWait = func(context.Context) error { waits.Add(1); return nil }
			result, err := client.Analyze(context.Background(), exampleSegments())
			if err != nil {
				t.Fatalf("expected retry success: %v", err)
			}
			if requests.Load() != 2 || waits.Load() != 1 || result.Source != "openrouter" {
				t.Fatalf("requests=%d waits=%d result=%#v", requests.Load(), waits.Load(), result)
			}
		})
	}
}

func TestOpenRouterStopsAfterOneRetry(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(response, "unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	client := NewOpenRouter("key", server.URL, "stealth/ox-alpha", "", time.Second)
	client.retryWait = func(context.Context) error { return nil }
	if _, err := client.Analyze(context.Background(), exampleSegments()); err == nil {
		t.Fatal("expected exhausted provider error")
	}
	if requests.Load() != 2 {
		t.Fatalf("expected exactly two total attempts, got %d", requests.Load())
	}
}

func TestOpenRouterConfiguredKeyDoesNotFallBackAfterExhaustion(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(response, "ox alpha unavailable", http.StatusBadGateway)
	}))
	defer server.Close()
	client := NewOpenRouter("configured-key", server.URL, "stealth/ox-alpha", "", time.Second)
	client.retryWait = func(context.Context) error { return nil }
	result, err := client.Analyze(context.Background(), exampleSegments())
	if err == nil || !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("expected exhausted Ox Alpha error, got result=%#v err=%v", result, err)
	}
	if result.Source == "local" || requests.Load() != 2 {
		t.Fatalf("configured provider failure must not fall back: result=%#v requests=%d", result, requests.Load())
	}
}

func TestOpenRouterDoesNotRetryNonRetryable4xx(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		http.Error(response, "invalid request", http.StatusBadRequest)
	}))
	defer server.Close()
	client := NewOpenRouter("key", server.URL, "stealth/ox-alpha", "", time.Second)
	var waits atomic.Int32
	client.retryWait = func(context.Context) error { waits.Add(1); return nil }
	if _, err := client.Analyze(context.Background(), exampleSegments()); err == nil {
		t.Fatal("expected 400 error")
	}
	if requests.Load() != 1 || waits.Load() != 0 {
		t.Fatalf("nonretryable 4xx retried: requests=%d waits=%d", requests.Load(), waits.Load())
	}
}

func TestOpenRouterCancellationAbortsBackoff(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "rate limited", http.StatusTooManyRequests)
	}))
	defer server.Close()
	client := NewOpenRouter("key", server.URL, "stealth/ox-alpha", "", time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	client.retryWait = func(waitCtx context.Context) error {
		cancel()
		<-waitCtx.Done()
		return waitCtx.Err()
	}
	_, err := client.Analyze(ctx, exampleSegments())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation during backoff, got %v", err)
	}
}

func TestOpenRouterHTTPTimeoutSurfacesWithoutFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		_, _ = io.WriteString(response, `{}`)
	}))
	defer server.Close()
	client := NewOpenRouter("key", server.URL, "stealth/ox-alpha", "", 20*time.Millisecond)
	result, err := client.Analyze(context.Background(), exampleSegments())
	if err == nil || result.Source == "local" {
		t.Fatalf("timeout must surface without fallback: result=%#v err=%v", result, err)
	}
}

func TestOpenRouterRejectsOversizedEnvelope(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = io.WriteString(response, strings.Repeat(" ", (4<<20)+1)+`{}`)
	}))
	defer server.Close()
	client := NewOpenRouter("key", server.URL, "stealth/ox-alpha", "", time.Second)
	client.retryWait = func(context.Context) error { return nil }
	if _, err := client.Analyze(context.Background(), exampleSegments()); err == nil {
		t.Fatal("oversized envelope must fail")
	}
	if requests.Load() != 2 {
		t.Fatalf("oversized envelope should receive one retry, got %d requests", requests.Load())
	}
}
