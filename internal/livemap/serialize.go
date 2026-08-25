package livemap

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

const treeLegend = "Q=question, I=idea, +=pro, -=con"

// EscapePromptText percent-encodes every character that can collide with the
// tree or turn-block grammar. It is reversible with UnescapePromptText.
func EscapePromptText(text string) string {
	var builder strings.Builder
	for _, r := range text {
		switch r {
		case '%', '\n', '\r', '[', ']', '(', ')', '#', '@', ':', '=', '+', '-':
			bytes := []byte(string(r))
			for _, b := range bytes {
				fmt.Fprintf(&builder, "%%%02X", b)
			}
		default:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

// UnescapePromptText reverses EscapePromptText.
func UnescapePromptText(text string) (string, error) {
	decoded, err := url.PathUnescape(text)
	if err != nil {
		return "", fmt.Errorf("unescape prompt text: %w", err)
	}
	return decoded, nil
}

// SerializeTree serializes the current topic for Call A. It always emits the
// required legend; an empty state uses the contract sentinel.
func SerializeTree(state *State) string {
	if state == nil || len(state.Topics) == 0 {
		return "(트리 비어 있음)"
	}
	return serializeTopics(state, len(state.Topics)-1)
}

// SerializeTreeForCallB serializes the current and immediately previous topic.
func SerializeTreeForCallB(state *State) string {
	if state == nil || len(state.Topics) == 0 {
		return "(트리 비어 있음)"
	}
	start := len(state.Topics) - 2
	if start < 0 {
		start = 0
	}
	return serializeTopics(state, start)
}

func serializeTopics(state *State, start int) string {
	var builder strings.Builder
	for index := start; index < len(state.Topics); index++ {
		topic := state.Topics[index]
		role := "현재 토픽"
		if index < len(state.Topics)-1 {
			role = "직전 토픽"
		}
		fmt.Fprintf(&builder, "## %s: [%s] %s\n", role, topic.ID, EscapePromptText(topic.Label))
		writeTopicNodes(&builder, state, topic)
	}
	builder.WriteString(treeLegend)
	return builder.String()
}

func writeTopicNodes(builder *strings.Builder, state *State, topic *Topic) {
	inTopic := make(map[string]bool, len(topic.NodeIDs))
	for _, id := range topic.NodeIDs {
		inTopic[id] = true
	}
	children := make(map[string][]*Node)
	orphans := make([]*Node, 0)
	roots := make([]*Node, 0)
	for _, id := range topic.NodeIDs {
		node := state.Nodes[id]
		if node == nil {
			continue
		}
		switch {
		case node.Orphan:
			orphans = append(orphans, node)
		case node.ParentID == "" || !inTopic[node.ParentID]:
			roots = append(roots, node)
		default:
			children[node.ParentID] = append(children[node.ParentID], node)
		}
	}
	byID := func(nodes []*Node) {
		sort.SliceStable(nodes, func(i, j int) bool { return nodeNumber(nodes[i].ID) < nodeNumber(nodes[j].ID) })
	}
	byID(orphans)
	byID(roots)
	for parent := range children {
		byID(children[parent])
	}
	for _, node := range orphans {
		writeNodeLine(builder, node, 0, true)
	}
	visited := make(map[string]bool)
	var walk func(*Node, int)
	walk = func(node *Node, depth int) {
		if visited[node.ID] {
			return
		}
		visited[node.ID] = true
		writeNodeLine(builder, node, depth, false)
		for _, child := range children[node.ID] {
			walk(child, depth+1)
		}
	}
	for _, node := range roots {
		walk(node, 0)
	}
}

func writeNodeLine(builder *strings.Builder, node *Node, depth int, orphan bool) {
	symbol := map[string]string{KindQuestion: "Q", KindIdea: "I", KindPro: "+", KindCon: "-"}[node.Kind]
	fmt.Fprintf(builder, "%s[%s](%s) %s", strings.Repeat("  ", depth), node.ID, symbol, EscapePromptText(node.Text))
	if orphan {
		builder.WriteString(" (미연결)")
	}
	builder.WriteByte('\n')
}

func nodeNumber(id string) int {
	var number int
	if _, err := fmt.Sscanf(id, "n%d", &number); err != nil {
		return int(^uint(0) >> 1)
	}
	return number
}

// ToMeetMapResult converts state to the exact shape consumed by the existing
// frontend. Relation labels preserve local.go conventions: answers=답변,
// supports=지지, objects_to=우려, elaborates=질문 확장, and the fifth contract
// relation follows_up=후속 질문.
func ToMeetMapResult(state *State) MeetMapResult {
	result := MeetMapResult{Topics: []MeetMapTopic{}}
	if state == nil {
		return result
	}
	for _, topic := range state.Topics {
		view := MeetMapTopic{ID: topic.ID, Label: topic.Label, Nodes: []MeetMapNode{}}
		for _, id := range topic.NodeIDs {
			node := state.Nodes[id]
			if node == nil {
				continue
			}
			view.Nodes = append(view.Nodes, MeetMapNode{
				ID: node.ID, SegmentIndex: node.SegmentIndex, Kind: MapKind(node.Kind),
				Summary: node.Text, ParentID: node.ParentID, Relation: relationLabel(node.Relation),
			})
		}
		result.Topics = append(result.Topics, view)
	}
	return result
}

func relationLabel(relation string) string {
	return map[string]string{
		RelationAnswers: "답변", RelationSupports: "지지", RelationObjectsTo: "우려",
		RelationElaborates: "질문 확장", RelationFollowsUp: "후속 질문",
	}[relation]
}
