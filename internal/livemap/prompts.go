package livemap

import (
	_ "embed"
	"fmt"
	"strings"
)

var (
	// SystemPromptA contains only static Call A instructions.
	//go:embed prompt_a.txt
	SystemPromptA string

	// SystemPromptB contains only static Call B instructions.
	//go:embed prompt_b.txt
	SystemPromptB string
)

// CallAInput contains all per-turn data for the Call A user message.
type CallAInput struct {
	Agenda            string
	CurrentTopicID    string
	CurrentTopicTitle string
	PrevTurns         string
	Tree              string
	Speaker           string
	Utterance         string
}

// CallBInput contains all per-node data for the Call B user message.
type CallBInput struct {
	Tree  string
	Type  string
	Text  string
	Quote string
}

// BuildUserMessageA renders a length-delimited data block. Length delimiters and
// escaped values prevent user text from terminating or forging another field.
func BuildUserMessageA(input CallAInput) string {
	return buildTurnBlock("CALL_A_TURN_DATA_V1", []blockField{
		{"agenda", sentinel(input.Agenda, "(아젠다 미설정)")},
		{"current_topic_id", sentinel(input.CurrentTopicID, "t0")},
		{"current_topic_title", sentinel(input.CurrentTopicTitle, "(미정)")},
		{"prev_turns", sentinel(input.PrevTurns, "(이전 턴 없음)")},
		{"tree", sentinel(input.Tree, "(트리 비어 있음)")},
		{"speaker", sentinel(input.Speaker, "화자")},
		{"utterance", EscapePromptText(input.Utterance)},
	})
}

// BuildUserMessageB renders a length-delimited per-node data block.
func BuildUserMessageB(input CallBInput) string {
	return buildTurnBlock("CALL_B_NODE_DATA_V1", []blockField{
		{"tree", sentinel(input.Tree, "(트리 비어 있음)")},
		{"type", EscapePromptText(input.Type)},
		{"text", EscapePromptText(input.Text)},
		{"quote", EscapePromptText(input.Quote)},
	})
}

type blockField struct {
	name  string
	value string
}

func buildTurnBlock(name string, fields []blockField) string {
	var builder strings.Builder
	builder.WriteString(name)
	builder.WriteByte('\n')
	for _, field := range fields {
		value := EscapePromptText(field.value)
		fmt.Fprintf(&builder, "@%s %d\n%s\n", field.name, len([]byte(value)), value)
	}
	builder.WriteString("@end\n")
	return builder.String()
}

func sentinel(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
