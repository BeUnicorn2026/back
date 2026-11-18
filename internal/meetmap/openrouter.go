package meetmap

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

const systemPrompt = `You implement the MeetMap AI-Map pipeline for Korean meeting transcripts.
1. Compare consecutive turns and split only when a genuinely new topic starts.
2. Ignore greetings, backchannels, and off-topic turns.
3. Tag every retained turn as exactly one of question, position, pro, con.
4. Summarize each node with no more than six whitespace-separated words, using only transcript evidence.
5. A position answers a question. A pro supports a position. A con opposes or raises concern about a position.
6. A node may occur only once and may have at most one parent. Parents must appear earlier in the same topic.
Return only a JSON object shaped as {"topics":[{"id":"topic-1","label":"...","nodes":[{"id":"t1-n1","segmentIndex":0,"kind":"question","summary":"...","parentId":"","relation":""}]}]}.
Do not invent speakers, claims, links, or text that is absent from the supplied transcript.`

var meetMapJSONSchema = map[string]any{
	"type":                 "object",
	"additionalProperties": false,
	"required":             []string{"topics"},
	"properties": map[string]any{
		"topics": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type":                 "object",
				"additionalProperties": false,
				"required":             []string{"id", "label", "nodes"},
				"properties": map[string]any{
					"id":    map[string]any{"type": "string"},
					"label": map[string]any{"type": "string"},
					"nodes": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type":                 "object",
							"additionalProperties": false,
							"required":             []string{"id", "segmentIndex", "kind", "summary", "parentId", "relation"},
							"properties": map[string]any{
								"id":           map[string]any{"type": "string"},
								"segmentIndex": map[string]any{"type": "integer", "minimum": 0},
								"kind":         map[string]any{"type": "string", "enum": []string{"question", "position", "pro", "con"}},
								"summary":      map[string]any{"type": "string"},
								"parentId":     map[string]any{"type": "string"},
								"relation":     map[string]any{"type": "string"},
							},
						},
					},
				},
			},
		},
	},
}

type Analyzer interface {
	Analyze(context.Context, []Segment) (Result, error)
}

type OpenRouter struct {
	APIKey    string
	BaseURL   string
	Model     string
	Referer   string
	HTTP      *http.Client
	retryWait func(context.Context) error
}

func NewOpenRouter(apiKey, baseURL, model, referer string, timeout time.Duration) *OpenRouter {
	return &OpenRouter{APIKey: apiKey, BaseURL: strings.TrimRight(baseURL, "/"), Model: model, Referer: referer, HTTP: &http.Client{Timeout: timeout}}
}

func (client *OpenRouter) Analyze(ctx context.Context, segments []Segment) (Result, error) {
	if client.APIKey == "" {
		result := Local(segments)
		if err := Validate(result, len(segments)); err != nil {
			return Result{}, err
		}
		return result, nil
	}
	transcript := make([]map[string]any, len(segments))
	for index, segment := range segments {
		transcript[index] = map[string]any{"segmentIndex": index, "speaker": segment.Speaker, "start": segment.Start, "end": segment.End, "text": segment.Text}
	}
	input, err := json.Marshal(map[string]any{"transcript": transcript})
	if err != nil {
		return Result{}, fmt.Errorf("encode transcript: %w", err)
	}
	body, err := json.Marshal(map[string]any{
		"model":    client.Model,
		"messages": []map[string]string{{"role": "system", "content": systemPrompt}, {"role": "user", "content": string(input)}},
		"response_format": map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "meetmap_result",
				"strict": true,
				"schema": meetMapJSONSchema,
			},
		},
		"provider":   map[string]bool{"require_parameters": true},
		"reasoning":  map[string]string{"effort": "low"},
		"max_tokens": 5000,
	})
	if err != nil {
		return Result{}, fmt.Errorf("encode OpenRouter request: %w", err)
	}
	var (
		result Result
		retry  bool
	)
	for attempt := 0; attempt < 2; attempt++ {
		result, retry, err = client.analyzeOnce(ctx, body, len(segments))
		if err == nil || !retry || attempt == 1 {
			return result, err
		}
		wait := client.retryWait
		if wait == nil {
			wait = waitForRetry
		}
		if waitErr := wait(ctx); waitErr != nil {
			return Result{}, fmt.Errorf("OpenRouter request failed: %w", waitErr)
		}
	}
	return result, err
}

func (client *OpenRouter) analyzeOnce(ctx context.Context, body []byte, segmentCount int) (Result, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, client.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Result{}, false, fmt.Errorf("create OpenRouter request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+client.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-OpenRouter-Title", "ConThink")
	if client.Referer != "" {
		req.Header.Set("HTTP-Referer", client.Referer)
	}
	response, err := client.HTTP.Do(req)
	if err != nil {
		return Result{}, false, fmt.Errorf("OpenRouter request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		details, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		retry := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
		return Result{}, retry, fmt.Errorf("OpenRouter returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(details)))
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
		return Result{}, true, fmt.Errorf("decode OpenRouter response: %w", err)
	}
	if err := ensureSingleJSON(decoder); err != nil {
		return Result{}, true, fmt.Errorf("OpenRouter response shape mismatch: %w", err)
	}
	if len(completion.Choices) == 0 || strings.TrimSpace(completion.Choices[0].Message.Content) == "" {
		return Result{}, true, fmt.Errorf("OpenRouter returned no MeetMap content")
	}
	var generated struct {
		Topics []Topic `json:"topics"`
	}
	contentDecoder := json.NewDecoder(strings.NewReader(completion.Choices[0].Message.Content))
	contentDecoder.DisallowUnknownFields()
	if err := contentDecoder.Decode(&generated); err != nil {
		return Result{}, true, fmt.Errorf("decode MeetMap JSON: %w", err)
	}
	if err := ensureSingleJSON(contentDecoder); err != nil {
		return Result{}, true, fmt.Errorf("MeetMap JSON shape mismatch: %w", err)
	}
	result := Result{Topics: generated.Topics, Source: "openrouter", Model: client.Model, AnalyzedSegmentCount: segmentCount}
	if err := Validate(result, segmentCount); err != nil {
		return Result{}, true, fmt.Errorf("validate MeetMap result: %w", err)
	}
	return result, false, nil
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

func waitForRetry(ctx context.Context) error {
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
