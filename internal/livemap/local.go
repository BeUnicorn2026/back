package livemap

import (
	"regexp"
	"strings"
)

// Regex heuristics mirror the classification approach of meetmap/local.go.
var (
	localQuestion = regexp.MustCompile(`(?i)[?？]$|어떻게|왜|무엇|어떤|할까요|인가요|맞나요|정할까요|결정`)
	localPro      = regexp.MustCompile(`장점|좋|찬성|효율|가능|도움|개선|유지|지원|이점`)
	localCon      = regexp.MustCompile(`우려|문제|위험|반대|어렵|불편|부족|실패|안 됩|없습|부담`)
	localIdea     = regexp.MustCompile(`하죠|하자|도입|제안|방식|가죠|합시다|추천`)
)

// LocalCallA produces a deterministic Call A result from regex heuristics so the
// engine runs without an LLM. It emits at most one node per turn.
func LocalCallA(state *State, turn Turn) CallAResult {
	text := strings.TrimSpace(turn.Text)
	result := CallAResult{Topic: CallATopic{IsNew: len(state.Topics) == 0, Title: localSummary(text), OffAgenda: false}}
	if text == "" || localIsChatter(text) {
		return result
	}
	result.Nodes = []CallANode{{Type: localKind(text), Text: localSummary(text), Quote: text, Terms: nil}}
	return result
}

// LocalCallB deterministically selects a compatible parent for a node, honoring
// the B-V3/B-V7 rules, or returns a null parent when none fits.
func LocalCallB(state *State, node *Node) CallBResult {
	parentKinds := parentKindsFor[node.Kind]
	for index := len(state.Order) - 1; index >= 0; index-- {
		candidate := state.Nodes[state.Order[index]]
		if candidate == nil || candidate.ID == node.ID || !parentKinds[candidate.Kind] {
			continue
		}
		relation := localRelation(node.Kind, candidate.Kind)
		if relation == "" {
			continue
		}
		parentID := candidate.ID
		return CallBResult{ParentID: &parentID, Relation: &relation, Confidence: 0.75, Reason: "local heuristic parent"}
	}
	return CallBResult{ParentID: nil, Relation: nil, Confidence: 0.5, Reason: "no compatible parent"}
}

func localKind(text string) string {
	switch {
	case localQuestion.MatchString(text):
		return KindQuestion
	case localCon.MatchString(text):
		return KindCon
	case localPro.MatchString(text):
		return KindPro
	case localIdea.MatchString(text):
		return KindIdea
	default:
		return KindQuestion
	}
}

func localRelation(childKind, parentKind string) string {
	// Do not depend on randomized Go map iteration: prefer the semantically
	// primary relation when more than one is compatible.
	for _, relation := range []string{
		RelationAnswers,
		RelationSupports,
		RelationObjectsTo,
		RelationElaborates,
		RelationFollowsUp,
	} {
		if relationCompat[childKind][parentKind][relation] {
			return relation
		}
	}
	return ""
}

func localIsChatter(text string) bool {
	chatter := []string{"네네", "맞아요", "안녕", "좋습니다", "넘어가", "쉬었다"}
	for _, marker := range chatter {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func localSummary(text string) string {
	words := strings.Fields(strings.NewReplacer(".", " ", ",", " ", "?", " ", "!", " ", "？", " ", "！", " ").Replace(text))
	if len(words) > maxTextWords {
		words = words[:maxTextWords]
	}
	summary := strings.Join(words, " ")
	if runes := []rune(summary); len(runes) > maxTextRunes {
		summary = string(runes[:maxTextRunes])
	}
	return summary
}
