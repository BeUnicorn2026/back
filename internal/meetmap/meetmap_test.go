package meetmap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestOpenRouterUsesOxAlphaAndValidatesJSON(t *testing.T) {
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
		format := body["response_format"].(map[string]any)
		if format["type"] != "json_object" {
			t.Fatalf("unexpected response format: %#v", format)
		}
		generated := Local(exampleSegments())
		content, _ := json.Marshal(map[string]any{"topics": generated.Topics})
		_ = json.NewEncoder(response).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": string(content)}}}})
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
