package livemap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

// Default per-call context deadlines. Call A does the heavier tagging work and
// gets more headroom than the narrow Call B parent lookup.
const (
	callATimeout = 15 * time.Second
	callBTimeout = 8 * time.Second

	callAMaxTokens = 2000
	callBMaxTokens = 600
)

// Caller performs the two structured LLM calls the session actor needs. The
// rendered userMessage is the prompt-cache-friendly user content used by the
// network implementation; state and turn/node are supplied so the local
// fallback can run the deterministic engine without a network round trip.
type Caller interface {
	CallA(ctx context.Context, userMessage string, state *State, turn Turn) (CallAResult, error)
	CallB(ctx context.Context, userMessage string, state *State, node *Node) (CallBResult, error)
}

// NewCaller returns an OpenRouter-backed Caller when an API key is configured,
// otherwise the deterministic local fallback.
func NewCaller(apiKey, baseURL, model, referer string) Caller {
	if strings.TrimSpace(apiKey) == "" {
		return LocalCaller{}
	}
	return NewOpenRouterCaller(apiKey, baseURL, model, referer)
}

// LocalCaller wraps the deterministic LocalCallA/LocalCallB heuristics so the
// live map degrades gracefully with no LLM configured.
type LocalCaller struct{}

// CallA runs the deterministic Call A heuristic.
func (LocalCaller) CallA(_ context.Context, _ string, state *State, turn Turn) (CallAResult, error) {
	return LocalCallA(state, turn), nil
}

// CallB runs the deterministic Call B heuristic.
func (LocalCaller) CallB(_ context.Context, _ string, state *State, node *Node) (CallBResult, error) {
	return LocalCallB(state, node), nil
}

// OpenRouterCaller issues strict json_schema structured completions, mirroring
// internal/meetmap/openrouter.go: static instructions live in the system
// message, variable turn data in the user message, and exactly one jittered
// retry covers 429/5xx/decode/shape failures.
type OpenRouterCaller struct {
	APIKey       string
	BaseURL      string
	Model        string
	Referer      string
	HTTP         *http.Client
	CallATimeout time.Duration
	CallBTimeout time.Duration
	// retryWait is overridable in tests to remove backoff latency.
	retryWait func(context.Context) error
}

// NewOpenRouterCaller builds a caller with the default per-call deadlines.
func NewOpenRouterCaller(apiKey, baseURL, model, referer string) *OpenRouterCaller {
	return &OpenRouterCaller{
		APIKey:       apiKey,
		BaseURL:      strings.TrimRight(baseURL, "/"),
		Model:        model,
		Referer:      referer,
		HTTP:         &http.Client{},
		CallATimeout: callATimeout,
		CallBTimeout: callBTimeout,
	}
}

// CallA sends the Call A turn message and decodes the tagging result.
func (c *OpenRouterCaller) CallA(ctx context.Context, userMessage string, _ *State, _ Turn) (CallAResult, error) {
	var out CallAResult
	err := c.invoke(ctx, c.timeout(c.CallATimeout, callATimeout), SystemPromptA, userMessage, SchemaAName, SchemaA, callAMaxTokens, func(content string) (bool, error) {
		out = CallAResult{}
		return decodeCallA(content, &out)
	})
	if err != nil {
		return CallAResult{}, err
	}
	return out, nil
}

// CallB sends the Call B per-node message and decodes the parent selection.
func (c *OpenRouterCaller) CallB(ctx context.Context, userMessage string, _ *State, _ *Node) (CallBResult, error) {
	var out CallBResult
	err := c.invoke(ctx, c.timeout(c.CallBTimeout, callBTimeout), SystemPromptB, userMessage, SchemaBName, SchemaB, callBMaxTokens, func(content string) (bool, error) {
		out = CallBResult{}
		return decodeCallB(content, &out)
	})
	if err != nil {
		return CallBResult{}, err
	}
	return out, nil
}

func (c *OpenRouterCaller) timeout(configured, fallback time.Duration) time.Duration {
	if configured > 0 {
		return configured
	}
	return fallback
}

// invoke applies a per-call deadline, then makes at most two attempts. parse
// decodes the model content and reports whether a decode/shape error is
// retryable.
func (c *OpenRouterCaller) invoke(ctx context.Context, timeout time.Duration, systemPrompt, userMessage, schemaName string, schema []byte, maxTokens int, parse func(string) (bool, error)) error {
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, err := c.buildBody(systemPrompt, userMessage, schemaName, schema, maxTokens)
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		content, retry, callErr := c.httpOnce(callCtx, body)
		if callErr == nil {
			var parseErr error
			retry, parseErr = parse(content)
			callErr = parseErr
		}
		if callErr == nil {
			return nil
		}
		lastErr = callErr
		if !retry || attempt == 1 {
			return lastErr
		}
		wait := c.retryWait
		if wait == nil {
			wait = jitteredBackoff
		}
		if waitErr := wait(callCtx); waitErr != nil {
			return fmt.Errorf("livemap OpenRouter retry aborted: %w", waitErr)
		}
	}
	return lastErr
}

func (c *OpenRouterCaller) buildBody(systemPrompt, userMessage, schemaName string, schema []byte, maxTokens int) ([]byte, error) {
	body, err := json.Marshal(map[string]any{
		"model": c.Model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userMessage},
		},
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   schemaName,
				"strict": true,
				"schema": json.RawMessage(schema),
			},
		},
		"provider":   map[string]bool{"require_parameters": true},
		"reasoning":  map[string]string{"effort": "low"},
		"max_tokens": maxTokens,
	})
	if err != nil {
		return nil, fmt.Errorf("encode livemap OpenRouter request: %w", err)
	}
	return body, nil
}

// httpOnce performs a single request and returns the model content, whether the
// error is retryable, and the error.
func (c *OpenRouterCaller) httpOnce(ctx context.Context, body []byte) (string, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", false, fmt.Errorf("create livemap OpenRouter request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-OpenRouter-Title", "ConThink")
	if c.Referer != "" {
		req.Header.Set("HTTP-Referer", c.Referer)
	}
	response, err := c.HTTP.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("livemap OpenRouter request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		details, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		retry := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
		return "", retry, fmt.Errorf("livemap OpenRouter returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(details)))
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	if err := decoder.Decode(&completion); err != nil {
		return "", true, fmt.Errorf("decode livemap OpenRouter envelope: %w", err)
	}
	if err := ensureSingleJSON(decoder); err != nil {
		return "", true, fmt.Errorf("livemap OpenRouter envelope shape mismatch: %w", err)
	}
	if len(completion.Choices) == 0 || strings.TrimSpace(completion.Choices[0].Message.Content) == "" {
		return "", true, fmt.Errorf("livemap OpenRouter returned no content")
	}
	return completion.Choices[0].Message.Content, false, nil
}

// decodeStrict decodes model content into out with unknown fields rejected. Any
// decode or shape mismatch is reported as retryable.
func decodeStrict(content string, out any) (bool, error) {
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return true, fmt.Errorf("decode livemap structured content: %w", err)
	}
	if err := ensureSingleJSON(decoder); err != nil {
		return true, fmt.Errorf("livemap structured content shape mismatch: %w", err)
	}
	return false, nil
}

// The provider is asked for a strict schema, but responses are still checked at
// the trust boundary. Go's JSON decoder cannot distinguish an omitted scalar
// from that scalar's zero value, so the raw required keys are checked first.
func decodeCallA(content string, out *CallAResult) (bool, error) {
	var raw struct {
		Topic *struct {
			IsNew     *bool   `json:"is_new"`
			Title     *string `json:"title"`
			OffAgenda *bool   `json:"off_agenda"`
		} `json:"topic"`
		Nodes *[]struct {
			Type  *string   `json:"type"`
			Text  *string   `json:"text"`
			Quote *string   `json:"quote"`
			Terms *[]string `json:"terms"`
		} `json:"nodes"`
	}
	if retry, err := decodeStrict(content, &raw); err != nil {
		return retry, err
	}
	if raw.Topic == nil || raw.Topic.IsNew == nil || raw.Topic.Title == nil || raw.Topic.OffAgenda == nil || raw.Nodes == nil {
		return true, fmt.Errorf("livemap Call A structured content is missing required fields")
	}
	if len(*raw.Nodes) > 8 {
		return true, fmt.Errorf("livemap Call A structured content has too many nodes")
	}
	for _, node := range *raw.Nodes {
		if node.Type == nil || node.Text == nil || node.Quote == nil || node.Terms == nil || !validSchemaNodeKind(strings.ToLower(strings.TrimSpace(*node.Type))) {
			return true, fmt.Errorf("livemap Call A node has an invalid schema shape")
		}
	}
	return decodeStrict(content, out)
}

func decodeCallB(content string, out *CallBResult) (bool, error) {
	var raw map[string]json.RawMessage
	if retry, err := decodeStrict(content, &raw); err != nil {
		return retry, err
	}
	for _, key := range []string{"parent_id", "relation", "confidence", "reason"} {
		if _, ok := raw[key]; !ok {
			return true, fmt.Errorf("livemap Call B structured content is missing %s", key)
		}
	}
	if len(raw) != 4 {
		return true, fmt.Errorf("livemap Call B structured content has unknown fields")
	}
	var confidence *float64
	if err := json.Unmarshal(raw["confidence"], &confidence); err != nil || confidence == nil {
		return true, fmt.Errorf("livemap Call B confidence must be a number")
	}
	var reason *string
	if err := json.Unmarshal(raw["reason"], &reason); err != nil || reason == nil {
		return true, fmt.Errorf("livemap Call B reason must be a string")
	}
	if retry, err := decodeStrict(content, out); err != nil {
		return retry, err
	}
	if out.Relation != nil && !validSchemaRelation(strings.ToLower(strings.TrimSpace(*out.Relation))) {
		return true, fmt.Errorf("livemap Call B relation is invalid")
	}
	return false, nil
}

func validSchemaNodeKind(kind string) bool {
	switch kind {
	case KindQuestion, KindIdea, KindPro, KindCon:
		return true
	default:
		return false
	}
}

func validSchemaRelation(relation string) bool {
	switch relation {
	case RelationAnswers, RelationSupports, RelationObjectsTo, RelationElaborates, RelationFollowsUp:
		return true
	default:
		return false
	}
}

func ensureSingleJSON(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("trailing JSON value")
	}
	return err
}

// jitteredBackoff waits 1-3s, cancelable via ctx, matching the batch pipeline.
func jitteredBackoff(ctx context.Context) error {
	delay := time.Second + time.Duration(rand.Int63n(int64(2*time.Second)+1))
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
