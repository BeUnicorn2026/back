package meetmap

import (
	"fmt"
	"strings"
)

type Segment struct {
	ID      string  `json:"id,omitempty"`
	Speaker string  `json:"speaker"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
}

type Request struct {
	MeetingID string    `json:"meetingId,omitempty"`
	Segments  []Segment `json:"segments"`
	TenantKey string    `json:"-"`
}

type Node struct {
	ID           string `json:"id"`
	SegmentIndex int    `json:"segmentIndex"`
	Kind         string `json:"kind"`
	Summary      string `json:"summary"`
	ParentID     string `json:"parentId,omitempty"`
	Relation     string `json:"relation,omitempty"`
}

type Topic struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Nodes []Node `json:"nodes"`
}

type Result struct {
	Topics               []Topic `json:"topics"`
	Source               string  `json:"source"`
	Model                string  `json:"model,omitempty"`
	AnalyzedSegmentCount int     `json:"analyzedSegmentCount"`
}

func NormalizeSegments(segments []Segment) ([]Segment, error) {
	if len(segments) == 0 {
		return nil, fmt.Errorf("분석할 실제 발화가 없습니다")
	}
	if len(segments) > 2000 {
		return nil, fmt.Errorf("발화는 한 번에 2000개까지 분석할 수 있습니다")
	}
	normalized := make([]Segment, 0, len(segments))
	for _, segment := range segments {
		segment.Text = strings.TrimSpace(segment.Text)
		segment.Speaker = strings.TrimSpace(segment.Speaker)
		if segment.Text == "" {
			continue
		}
		if len([]rune(segment.Text)) > 10000 {
			return nil, fmt.Errorf("발화 한 개는 10000자 이하여야 합니다")
		}
		if segment.Speaker == "" {
			segment.Speaker = "화자"
		}
		if segment.Start < 0 {
			segment.Start = 0
		}
		if segment.End < segment.Start {
			segment.End = segment.Start
		}
		normalized = append(normalized, segment)
	}
	if len(normalized) == 0 {
		return nil, fmt.Errorf("분석할 실제 발화가 없습니다")
	}
	return normalized, nil
}
