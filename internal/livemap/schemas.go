package livemap

import _ "embed"

const (
	// SchemaAName is the stable json_schema grammar cache name for Call A.
	SchemaAName = "live_turn_tagging"
	// SchemaBName is the stable json_schema grammar cache name for Call B.
	SchemaBName = "live_parent_selection"
)

var (
	// SchemaA is the embedded strict Call A JSON schema.
	//go:embed schema_a.json
	SchemaA []byte

	// SchemaB is the embedded strict Call B JSON schema. The consistent anyOf
	// nullable form works for both Anthropic and OpenAI strict structured output.
	//go:embed schema_b.json
	SchemaB []byte
)
