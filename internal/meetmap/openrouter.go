package meetmap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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

type Analyzer interface {
	Analyze(context.Context, []Segment) (Result, error)
}

type OpenRouter struct {
	APIKey  string
	BaseURL string
	Model   string
	Referer string
	HTTP    *http.Client
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
		"model":           client.Model,
		"messages":        []map[string]string{{"role": "system", "content": systemPrompt}, {"role": "user", "content": string(input)}},
		"response_format": map[string]string{"type": "json_object"},
		"provider":        map[string]bool{"require_parameters": true},
		"reasoning":       map[string]string{"effort": "low"},
		"temperature":     0.1,
		"max_tokens":      5000,
	})
	if err != nil {
		return Result{}, fmt.Errorf("encode OpenRouter request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, client.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Result{}, fmt.Errorf("create OpenRouter request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+client.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-OpenRouter-Title", "Voice Partition")
	if client.Referer != "" {
		req.Header.Set("HTTP-Referer", client.Referer)
	}
	response, err := client.HTTP.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("OpenRouter request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		details, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return Result{}, fmt.Errorf("OpenRouter returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(details)))
	}
	var completion struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&completion); err != nil {
		return Result{}, fmt.Errorf("decode OpenRouter response: %w", err)
	}
	if len(completion.Choices) == 0 || strings.TrimSpace(completion.Choices[0].Message.Content) == "" {
		return Result{}, fmt.Errorf("OpenRouter returned no MeetMap content")
	}
	var generated struct {
		Topics []Topic `json:"topics"`
	}
	decoder := json.NewDecoder(strings.NewReader(completion.Choices[0].Message.Content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&generated); err != nil {
		return Result{}, fmt.Errorf("decode MeetMap JSON: %w", err)
	}
	result := Result{Topics: generated.Topics, Source: "openrouter", Model: client.Model, AnalyzedSegmentCount: len(segments)}
	if err := Validate(result, len(segments)); err != nil {
		return Result{}, fmt.Errorf("validate MeetMap result: %w", err)
	}
	return result, nil
}
