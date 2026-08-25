package meetmap

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	questionPattern = regexp.MustCompile(`(?i)[?？]$|어떻게|왜|무엇|어떤|할까요|인가요|맞나요`)
	proPattern      = regexp.MustCompile(`장점|좋|찬성|효율|가능|도움|개선|유지|지원`)
	conPattern      = regexp.MustCompile(`우려|문제|위험|반대|어렵|불편|부족|실패|안 됩|없습`)
)

func Local(segments []Segment) Result {
	topics := make([]Topic, 0)
	for index, segment := range segments {
		newTopic := len(topics) == 0 || index > 0 && (segment.Start-segments[index-1].End > 12 || len(topics[len(topics)-1].Nodes) >= 7)
		if newTopic {
			topics = append(topics, Topic{ID: fmt.Sprintf("topic-%d", len(topics)+1)})
		}
		topic := &topics[len(topics)-1]
		kind := kindFor(segment.Text)
		node := Node{ID: fmt.Sprintf("t%d-n%d", len(topics), len(topic.Nodes)+1), SegmentIndex: index, Kind: kind, Summary: summary(segment.Text)}
		if len(topic.Nodes) > 0 {
			parent := chooseParent(topic.Nodes, kind)
			node.ParentID = parent.ID
			node.Relation = relationFor(kind)
		}
		topic.Nodes = append(topic.Nodes, node)
		if topic.Label == "" {
			topic.Label = node.Summary
		}
	}
	return Result{Topics: topics, Source: "local", AnalyzedSegmentCount: len(segments)}
}

func kindFor(text string) string {
	text = strings.TrimSpace(text)
	switch {
	case questionPattern.MatchString(text):
		return "question"
	case conPattern.MatchString(text):
		return "con"
	case proPattern.MatchString(text):
		return "pro"
	default:
		return "position"
	}
}

func summary(text string) string {
	words := strings.Fields(strings.NewReplacer(".", " ", ",", " ", "?", " ", "!", " ", "？", " ", "！", " ").Replace(text))
	if len(words) > 6 {
		words = words[:6]
	}
	return strings.Join(words, " ")
}

func chooseParent(nodes []Node, kind string) Node {
	preferred := map[string]string{"position": "question", "pro": "position", "con": "position"}[kind]
	if preferred != "" {
		for index := len(nodes) - 1; index >= 0; index-- {
			if nodes[index].Kind == preferred {
				return nodes[index]
			}
		}
	}
	return nodes[len(nodes)-1]
}

func relationFor(kind string) string {
	switch kind {
	case "position":
		return "답변"
	case "pro":
		return "지지"
	case "con":
		return "우려"
	default:
		return "질문 확장"
	}
}
