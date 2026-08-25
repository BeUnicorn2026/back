package livemap

import (
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const (
	maxTextRunes    = 20
	maxTextWords    = 5
	maxTitleWords   = 6
	lowConfidence   = 0.6
	maxReattachTrie = 2
)

var validNodeType = map[string]bool{KindQuestion: true, KindIdea: true, KindPro: true, KindCon: true}

var validRelation = map[string]bool{
	RelationAnswers: true, RelationSupports: true, RelationObjectsTo: true,
	RelationElaborates: true, RelationFollowsUp: true,
}

// parentKindsFor lists the parent node kinds allowed for a child kind (B-V3).
var parentKindsFor = map[string]map[string]bool{
	KindPro:      {KindIdea: true},
	KindCon:      {KindIdea: true},
	KindIdea:     {KindQuestion: true},
	KindQuestion: {KindQuestion: true, KindIdea: true},
}

// relationCompat encodes B-V7: allowed (parentKind, relation) pairs keyed by the
// child node kind. It is derived from the semantic table in prompt_b.txt.
var relationCompat = map[string]map[string]map[string]bool{
	KindIdea: {KindQuestion: {RelationAnswers: true}},
	KindPro:  {KindIdea: {RelationSupports: true}},
	KindCon:  {KindIdea: {RelationObjectsTo: true}},
	KindQuestion: {
		KindQuestion: {RelationElaborates: true, RelationFollowsUp: true},
		KindIdea:     {RelationElaborates: true, RelationFollowsUp: true},
	},
}

var quoteStripSet = map[rune]bool{}

func init() {
	for _, r := range ".,!?…·、。\"'“”‘’()[]{}<>~-" {
		quoteStripSet[r] = true
	}
}

// NormalizeForQuote applies the L-4 pipeline: full Unicode NFKC, collapse
// whitespace runs to a single ASCII space, strip the fixed contract punctuation
// set, then trim. Punctuation is checked after NFKC so compatibility forms such
// as fullwidth commas are handled identically to their canonical counterparts.
func NormalizeForQuote(text string) string {
	var builder strings.Builder
	previousSpace := false
	for _, r := range norm.NFKC.String(text) {
		if unicode.IsSpace(r) || r == rune(0xFEFF) {
			if !previousSpace {
				builder.WriteByte(' ')
				previousSpace = true
			}
			continue
		}
		previousSpace = false
		if quoteStripSet[r] {
			continue
		}
		builder.WriteRune(r)
	}
	return strings.TrimSpace(builder.String())
}

// quoteContains reports whether quote is a normalized substring of utterance.
func quoteContains(utterance, quote string) bool {
	normQuote := NormalizeForQuote(quote)
	if normQuote == "" {
		return false
	}
	return strings.Contains(NormalizeForQuote(utterance), normQuote)
}

func truncateText(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	changed := false
	if words := strings.Fields(trimmed); len(words) > maxTextWords {
		trimmed = strings.Join(words[:maxTextWords], " ")
		changed = true
	}
	if runes := []rune(trimmed); len(runes) > maxTextRunes {
		trimmed = string(runes[:maxTextRunes])
		changed = true
	}
	return trimmed, changed
}

// NeedsCallB reports whether a freshly created node requires a Call B parent
// lookup. The very first node of an otherwise empty tree cannot have a parent.
func NeedsCallB(state *State) bool {
	if state == nil {
		return false
	}
	return len(state.Nodes) > 1 || len(state.Topics) > 1
}

// ApplyCallA validates a Call A result against A-V1..A-V7, allocates server-side
// node IDs, updates the topic, and returns the resulting Delta.
func ApplyCallA(state *State, turn Turn, result CallAResult) Delta {
	if state.Nodes == nil {
		state.Nodes = make(map[string]*Node)
	}
	counters := state.Counters

	title := strings.TrimSpace(result.Topic.Title)
	if len(strings.Fields(title)) > maxTitleWords { // A-V4
		counters.violation("A-V4")
		title = ""
	}

	// L-5: off_agenda && is_new switches topic and flags it OffAgenda.
	topic := ensureTopic(state, result.Topic, title)
	delta := Delta{TopicChanged: result.Topic.IsNew, Topic: &TopicInfo{ID: topic.ID, Label: topic.Label, OffAgenda: topic.OffAgenda}}

	nodes := result.Nodes
	if result.Topic.OffAgenda && len(nodes) > 0 { // A-V5
		counters.violation("A-V5")
		nodes = nil
	}

	for _, candidate := range nodes {
		kind := strings.ToLower(strings.TrimSpace(candidate.Type)) // A-V1
		if !validNodeType[kind] {
			counters.violation("A-V1")
			continue
		}
		if !quoteContains(turn.Text, candidate.Quote) { // A-V3 -> discard node
			counters.violation("A-V3")
			continue
		}
		text, truncated := truncateText(candidate.Text) // A-V2
		if truncated {
			counters.truncation("A-V2")
		}
		id := allocateNodeID(state)
		node := &Node{ID: id, SegmentIndex: turn.SegmentIndex, Kind: kind, Text: text, Quote: candidate.Quote, Orphan: true, Confidence: 0}
		state.Nodes[id] = node
		state.Order = append(state.Order, id)
		topic.NodeIDs = append(topic.NodeIDs, id)
		counters.orphan()

		for _, term := range validTerms(candidate.Quote, candidate.Terms, counters) { // A-V6 (L-2: against quote)
			entry := Term{Text: term, NodeID: id, SegmentIndex: turn.SegmentIndex}
			state.Terms = append(state.Terms, entry)
			delta.Terms = append(delta.Terms, entry)
		}
		delta.Nodes = append(delta.Nodes, viewOf(node))
	}
	rememberTurn(state, turn)
	return delta
}

// ApplyCallB validates a Call B result against B-V1..B-V7 for one node. Any
// structural rejection leaves the node an orphan.
func ApplyCallB(state *State, nodeID string, result CallBResult) Delta {
	counters := state.Counters
	node := state.Nodes[nodeID]
	delta := Delta{}
	if node == nil {
		return delta
	}

	confidence := result.Confidence // B-V5 clamp
	if confidence < 0 {
		confidence = 0
		counters.clamp()
	} else if confidence > 1 {
		confidence = 1
		counters.clamp()
	}
	node.Confidence = confidence
	node.ReattachTries++

	parentID := trimPointer(result.ParentID)
	relation := ""
	if result.Relation != nil {
		relation = strings.ToLower(strings.TrimSpace(*result.Relation)) // B-V1
	}

	// B-V4: parent_id and relation must both be null or both non-null.
	if (parentID == "") != (relation == "") {
		counters.violation("B-V4")
		return orphanResult(node, delta)
	}
	if parentID == "" { // legitimately unattached
		return orphanResult(node, delta)
	}
	if !validRelation[relation] { // enum check (case-normalized above)
		counters.violation("B-V1")
		return orphanResult(node, delta)
	}
	parent := state.Nodes[parentID]
	if parent == nil { // B-V2 unknown id
		counters.violation("B-V2")
		return orphanResult(node, delta)
	}
	if !parentKindsFor[node.Kind][parent.Kind] { // B-V3 type compatibility
		counters.violation("B-V3")
		return orphanResult(node, delta)
	}
	if !relationCompat[node.Kind][parent.Kind][relation] { // B-V7 (type, relation)
		counters.violation("B-V7")
		return orphanResult(node, delta)
	}

	node.ParentID = parentID
	node.Relation = relation
	node.Orphan = false
	if confidence < lowConfidence { // B-V6 low-confidence flag
		counters.violation("B-V6")
	}
	delta.Nodes = append(delta.Nodes, viewOf(node))
	return delta
}

func orphanResult(node *Node, delta Delta) Delta {
	node.ParentID = ""
	node.Relation = ""
	node.Orphan = true
	delta.Nodes = append(delta.Nodes, viewOf(node))
	return delta
}

func ensureTopic(state *State, decision CallATopic, title string) *Topic {
	newTopic := decision.IsNew || len(state.Topics) == 0
	if newTopic {
		if title == "" {
			title = strings.TrimSpace(decision.Title)
		}
		topic := &Topic{ID: allocateTopicID(state), Label: title, OffAgenda: decision.OffAgenda}
		state.Topics = append(state.Topics, topic)
		return topic
	}
	topic := state.Topics[len(state.Topics)-1]
	if title != "" { // A-V4: keep previous title on violation
		topic.Label = title
	}
	topic.OffAgenda = decision.OffAgenda
	return topic
}

func validTerms(quote string, terms []string, counters *Counters) []string {
	normalizedQuote := NormalizeForQuote(quote)
	kept := make([]string, 0, len(terms))
	for _, term := range terms {
		trimmed := strings.TrimSpace(term)
		if trimmed == "" {
			continue
		}
		if !strings.Contains(normalizedQuote, NormalizeForQuote(trimmed)) { // A-V6 (L-2)
			counters.violation("A-V6")
			continue
		}
		kept = append(kept, trimmed)
	}
	return kept
}

func rememberTurn(state *State, turn Turn) {
	state.PrevTurns = append(state.PrevTurns, turn)
	if len(state.PrevTurns) > DefaultPreviousTurn {
		state.PrevTurns = state.PrevTurns[len(state.PrevTurns)-DefaultPreviousTurn:]
	}
}

func allocateNodeID(state *State) string {
	return fmt.Sprintf("n%02d", len(state.Order)+1)
}

func allocateTopicID(state *State) string {
	return fmt.Sprintf("t%d", len(state.Topics)+1)
}

func trimPointer(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func viewOf(node *Node) NodeView {
	return NodeView{
		ID: node.ID, SegmentIndex: node.SegmentIndex, Kind: MapKind(node.Kind),
		Summary: node.Text, ParentID: node.ParentID, Relation: relationLabel(node.Relation),
		Confidence: node.Confidence, Orphan: node.Orphan, LowConfidence: !node.Orphan && node.Confidence < lowConfidence,
	}
}
