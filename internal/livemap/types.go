// Package livemap incrementally builds a validated IBIS dialogue tree from
// finalized speech turns.
package livemap

// Node kinds used by the IBIS engine.
const (
	KindQuestion = "question"
	KindIdea     = "idea"
	KindPro      = "pro"
	KindCon      = "con"
)

// Relations used between IBIS nodes.
const (
	RelationAnswers     = "answers"
	RelationSupports    = "supports"
	RelationObjectsTo   = "objects_to"
	RelationElaborates  = "elaborates"
	RelationFollowsUp   = "follows_up"
	DefaultPreviousTurn = 2
)

// Turn is one finalized speech turn.
type Turn struct {
	Speaker      string
	Text         string
	SegmentIndex int
	Start        float64
	End          float64
}

// Node is a server-owned IBIS tree node.
type Node struct {
	ID            string
	SegmentIndex  int
	Kind          string
	Text          string
	Quote         string
	ParentID      string
	Relation      string
	Confidence    float64
	Orphan        bool
	ReattachTries int
}

// Topic groups nodes belonging to one discussion topic.
type Topic struct {
	ID        string
	Label     string
	OffAgenda bool
	NodeIDs   []string
}

// State is the complete incremental dialogue-tree state.
type State struct {
	Topics    []*Topic
	Nodes     map[string]*Node
	Order     []string
	PrevTurns []Turn
	Terms     []Term
	Counters  *Counters
}

// NewState returns an initialized, empty dialogue-tree state.
func NewState() *State {
	return &State{Nodes: make(map[string]*Node), Counters: NewCounters()}
}

// Term records a term and the node and segment from which it was extracted.
type Term struct {
	Text         string `json:"text"`
	NodeID       string `json:"nodeId"`
	SegmentIndex int    `json:"segmentIndex"`
}

// CallATopic is the topic decision returned by Call A.
type CallATopic struct {
	IsNew     bool   `json:"is_new"`
	Title     string `json:"title"`
	OffAgenda bool   `json:"off_agenda"`
}

// CallANode is one proposed IBIS node returned by Call A.
type CallANode struct {
	Type  string   `json:"type"`
	Text  string   `json:"text"`
	Quote string   `json:"quote"`
	Terms []string `json:"terms"`
}

// CallAResult mirrors the structured response schema for Call A.
type CallAResult struct {
	Topic CallATopic  `json:"topic"`
	Nodes []CallANode `json:"nodes"`
}

// CallBResult mirrors the structured response schema for Call B. Pointers
// preserve the distinction between JSON null and an empty string.
type CallBResult struct {
	ParentID   *string `json:"parent_id"`
	Relation   *string `json:"relation"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`
}

// TopicInfo is the topic portion of an incremental Delta.
type TopicInfo struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	OffAgenda bool   `json:"offAgenda"`
}

// NodeView is the client-facing form of an incremental node.
type NodeView struct {
	ID            string  `json:"id"`
	SegmentIndex  int     `json:"segmentIndex"`
	Kind          string  `json:"kind"`
	Summary       string  `json:"summary"`
	ParentID      string  `json:"parentId,omitempty"`
	Relation      string  `json:"relation,omitempty"`
	Confidence    float64 `json:"confidence"`
	Orphan        bool    `json:"orphan"`
	LowConfidence bool    `json:"lowConfidence"`
}

// LinkView describes a parent link added during reattachment.
type LinkView struct {
	NodeID     string  `json:"nodeId"`
	ParentID   string  `json:"parentId"`
	Relation   string  `json:"relation"`
	Confidence float64 `json:"confidence"`
}

// Delta contains the validated changes made by one Call A or Call B result.
type Delta struct {
	TopicChanged bool       `json:"topicChanged"`
	Topic        *TopicInfo `json:"topic,omitempty"`
	Nodes        []NodeView `json:"nodes"`
	Reattached   []LinkView `json:"reattached"`
	Terms        []Term     `json:"terms"`
}

// MeetMapNode is the exact node shape consumed by the existing frontend.
type MeetMapNode struct {
	ID           string `json:"id"`
	SegmentIndex int    `json:"segmentIndex"`
	Kind         string `json:"kind"`
	Summary      string `json:"summary"`
	ParentID     string `json:"parentId,omitempty"`
	Relation     string `json:"relation,omitempty"`
}

// MeetMapTopic is the exact topic shape consumed by the existing frontend.
type MeetMapTopic struct {
	ID    string        `json:"id"`
	Label string        `json:"label"`
	Nodes []MeetMapNode `json:"nodes"`
}

// MeetMapResult is the exact top-level shape consumed by the existing frontend.
type MeetMapResult struct {
	Topics []MeetMapTopic `json:"topics"`
}

// MapKind maps internal IBIS vocabulary to the existing renderer vocabulary.
func MapKind(kind string) string {
	if kind == KindIdea {
		return "position"
	}
	return kind
}
