package meetmap

import (
	"fmt"
	"strings"
)

var validKinds = map[string]bool{"question": true, "position": true, "pro": true, "con": true}

func Validate(result Result, segmentCount int) error {
	if len(result.Topics) == 0 {
		return fmt.Errorf("주제가 하나도 생성되지 않았습니다")
	}
	seenNodes := make(map[string]bool)
	seenSegments := make(map[int]bool)
	for _, topic := range result.Topics {
		if strings.TrimSpace(topic.ID) == "" || strings.TrimSpace(topic.Label) == "" || len(topic.Nodes) == 0 {
			return fmt.Errorf("모든 주제에는 ID, 제목, 노드가 필요합니다")
		}
		topicNodes := make(map[string]bool)
		for index, node := range topic.Nodes {
			if node.ID == "" || seenNodes[node.ID] {
				return fmt.Errorf("노드 ID는 전체 결과에서 고유해야 합니다")
			}
			if !validKinds[node.Kind] {
				return fmt.Errorf("지원하지 않는 대화 태그입니다: %s", node.Kind)
			}
			if node.SegmentIndex < 0 || node.SegmentIndex >= segmentCount || seenSegments[node.SegmentIndex] {
				return fmt.Errorf("각 발화는 구조도에서 최대 한 번만 사용할 수 있습니다")
			}
			if len(strings.Fields(node.Summary)) == 0 || len(strings.Fields(node.Summary)) > 6 {
				return fmt.Errorf("노드 요약은 1~6단어여야 합니다")
			}
			if index == 0 && (node.ParentID != "" || node.Relation != "") {
				return fmt.Errorf("주제의 첫 노드는 상위 연결을 가질 수 없습니다")
			}
			if index > 0 && (!topicNodes[node.ParentID] || strings.TrimSpace(node.Relation) == "") {
				return fmt.Errorf("상위 노드는 같은 주제 안에서 먼저 정의되어야 합니다")
			}
			seenNodes[node.ID] = true
			topicNodes[node.ID] = true
			seenSegments[node.SegmentIndex] = true
		}
	}
	return nil
}
