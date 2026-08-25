package livemap

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

// scriptedCaller drives the actor from canned decisions keyed off the turn text
// and node kind, so session behavior is exercised with no network.
type scriptedCaller struct {
	a func(turn Turn) (CallAResult, error)
	b func(node *Node) (CallBResult, error)
}

func (c scriptedCaller) CallA(_ context.Context, _ string, _ *State, turn Turn) (CallAResult, error) {
	return c.a(turn)
}

func (c scriptedCaller) CallB(_ context.Context, _ string, _ *State, node *Node) (CallBResult, error) {
	return c.b(node)
}

// twoTurnCaller returns a question then an idea that attaches to the question.
func twoTurnCaller() scriptedCaller {
	return scriptedCaller{
		a: func(turn Turn) (CallAResult, error) {
			switch turn.SegmentIndex {
			case 0:
				return CallAResult{
					Topic: CallATopic{IsNew: true, Title: "인증 방식"},
					Nodes: []CallANode{{Type: "question", Text: "인증 방식", Quote: turn.Text}},
				}, nil
			default:
				return CallAResult{
					Topic: CallATopic{IsNew: false, Title: "인증 방식"},
					Nodes: []CallANode{{Type: "idea", Text: "OAuth 도입", Quote: turn.Text}},
				}, nil
			}
		},
		b: func(node *Node) (CallBResult, error) {
			if node.Kind == KindIdea {
				return CallBResult{ParentID: ptr("n01"), Relation: ptr("answers"), Confidence: 0.85}, nil
			}
			return CallBResult{ParentID: nil, Relation: nil, Confidence: 0.3}, nil
		},
	}
}

func newTestManager(t *testing.T, caller Caller, opts ManagerOptions) *Manager {
	t.Helper()
	if opts.JanitorEvery == 0 {
		opts.JanitorEvery = time.Hour // never fires in-test; sweeps are called manually
	}
	manager := NewManager(caller, opts)
	t.Cleanup(manager.Close)
	return manager
}

func eventTypes(events []Event) []string {
	types := make([]string, len(events))
	for index, event := range events {
		types[index] = event.Type
	}
	return types
}

func TestSessionHappyPathEmitsOrderedDeltas(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{})
	session, err := manager.Create("org-1:user-1", "meeting-1", []string{"인증 방식 결정"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Enqueue("turn-1", "이하늘", "인증 방식 결정합시다", 0, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := session.Enqueue("turn-2", "지수", "OAuth 도입하죠", 1, 2); err != nil {
		t.Fatal(err)
	}
	session.Finalize()

	snapshot := session.Snapshot(0)
	if len(snapshot.Deltas) < 4 {
		t.Fatalf("expected at least 4 deltas, got %v", eventTypes(snapshot.Deltas))
	}
	want := []string{"topic_started", "node_added", "node_added", "link_added"}
	for index, expected := range want {
		if snapshot.Deltas[index].Type != expected {
			t.Fatalf("delta %d = %q, want %q (all: %v)", index, snapshot.Deltas[index].Type, expected, eventTypes(snapshot.Deltas))
		}
	}
	for index, event := range snapshot.Deltas {
		if event.Seq != int64(index+1) {
			t.Fatalf("seq not monotonic from 1: %+v", eventTypes(snapshot.Deltas))
		}
	}
	topic := snapshot.Deltas[0].Topic
	if topic == nil || topic.ID != "t1" {
		t.Fatalf("topic_started payload wrong: %+v", topic)
	}
	node := snapshot.Deltas[1].Node
	if node == nil || node.ID != "n01" || node.Kind != "question" || node.Speaker != "이하늘" || node.TurnID != "turn-1" || node.TopicID != "t1" {
		t.Fatalf("node_added payload wrong: %+v", node)
	}
	link := snapshot.Deltas[3].Link
	if link == nil || link.NodeID != "n02" || link.ParentID != "n01" || link.Relation != "answers" || link.RelationLabel != "답변" || link.Confidence != 0.85 {
		t.Fatalf("link_added payload wrong: %+v", link)
	}
	if snapshot.Deltas[len(snapshot.Deltas)-1].Type != "finalized" {
		t.Fatalf("expected finalized as last delta: %v", eventTypes(snapshot.Deltas))
	}
	if len(snapshot.Result.Topics) != 1 || len(snapshot.Result.Topics[0].Nodes) != 2 {
		t.Fatalf("result should carry 1 topic / 2 nodes: %+v", snapshot.Result)
	}
}

func TestEventJSONContracts(t *testing.T) {
	tests := []struct {
		name  string
		event Event
		want  string
	}{
		{name: "topic_started", event: Event{Seq: 1, Type: "topic_started", Topic: &TopicEvent{ID: "t1", Label: "인증", OffAgenda: false}}, want: `{"seq":1,"type":"topic_started","topic":{"id":"t1","label":"인증","offAgenda":false}}`},
		{name: "node_added", event: Event{Seq: 2, Type: "node_added", Node: &NodeEvent{ID: "n01", TopicID: "t1", Kind: "position", Summary: "OAuth", Speaker: "민수", TurnID: "u1", SegmentIndex: 0}}, want: `{"seq":2,"type":"node_added","node":{"id":"n01","topicId":"t1","kind":"position","summary":"OAuth","speaker":"민수","turnId":"u1","segmentIndex":0}}`},
		{name: "link_added", event: Event{Seq: 3, Type: "link_added", Link: &LinkEvent{NodeID: "n02", ParentID: "n01", Relation: "answers", RelationLabel: "답변", Confidence: 0.8}}, want: `{"seq":3,"type":"link_added","link":{"nodeId":"n02","parentId":"n01","relation":"answers","relationLabel":"답변","confidence":0.8}}`},
		{name: "finalized", event: Event{Seq: 4, Type: "finalized"}, want: `{"seq":4,"type":"finalized"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := json.Marshal(test.event)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.want {
				t.Fatalf("event JSON = %s, want %s", got, test.want)
			}
		})
	}
}

func TestSessionMapsIdeaKindToPosition(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	session.Enqueue("t1", "s", "인증 방식 결정합시다", 0, 1)
	session.Enqueue("t2", "s", "OAuth 도입하죠", 1, 2)
	session.Finalize()
	for _, event := range session.Snapshot(0).Deltas {
		if event.Node != nil && event.Node.Kind == KindIdea {
			t.Fatalf("node_added kind must be mapped away from idea: %+v", event.Node)
		}
	}
}

func TestSessionNeedsCallBSkipsFirstNode(t *testing.T) {
	var mu sync.Mutex
	called := 0
	caller := scriptedCaller{
		a: func(turn Turn) (CallAResult, error) {
			return CallAResult{
				Topic: CallATopic{IsNew: true, Title: "인증"},
				Nodes: []CallANode{{Type: "question", Text: "인증 방식", Quote: turn.Text}},
			}, nil
		},
		b: func(node *Node) (CallBResult, error) {
			mu.Lock()
			called++
			mu.Unlock()
			return CallBResult{ParentID: nil, Relation: nil, Confidence: 0.5}, nil
		},
	}
	manager := newTestManager(t, caller, ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	session.Enqueue("t1", "s", "인증 방식 결정합시다", 0, 1)
	session.Finalize()
	mu.Lock()
	defer mu.Unlock()
	if called != 0 {
		t.Fatalf("Call B must be skipped for the first node, got %d calls", called)
	}
}

func TestSessionCallBFailureLeavesOrphanAndContinues(t *testing.T) {
	caller := twoTurnCaller()
	caller.b = func(node *Node) (CallBResult, error) {
		return CallBResult{}, errors.New("call B network failure")
	}
	manager := newTestManager(t, caller, ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	session.Enqueue("t1", "s", "인증 방식 결정합시다", 0, 1)
	session.Enqueue("t2", "s", "OAuth 도입하죠", 1, 2)
	final := session.Finalize()
	if final.Metrics.CallBFailures == 0 {
		t.Fatalf("expected Call B failures counted, got %+v", final.Metrics)
	}
	// Processing continued: both nodes exist, and the idea stayed an orphan.
	nodes := final.Result.Topics[0].Nodes
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes despite Call B failure, got %d", len(nodes))
	}
	for _, node := range nodes {
		if node.ID == "n02" && node.ParentID != "" {
			t.Fatalf("n02 should remain an orphan after Call B failure: %+v", node)
		}
	}
	for _, event := range session.Snapshot(0).Deltas {
		if event.Type == "link_added" {
			t.Fatalf("no link should be emitted when Call B fails: %+v", event.Link)
		}
	}
}

func TestSessionRejectsSelfAndForwardParents(t *testing.T) {
	caller := twoTurnCaller()
	caller.b = func(node *Node) (CallBResult, error) {
		if node.ID == "n01" {
			return CallBResult{ParentID: ptr("n02"), Relation: ptr(RelationElaborates), Confidence: 0.8}, nil
		}
		return CallBResult{ParentID: ptr(node.ID), Relation: ptr(RelationAnswers), Confidence: 0.8}, nil
	}
	manager := newTestManager(t, caller, ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	session.Enqueue("t1", "s", "인증 방식 결정합시다", 0, 1)
	session.Enqueue("t2", "s", "OAuth 도입하죠", 1, 2)
	final := session.Finalize()
	for _, node := range final.Result.Topics[0].Nodes {
		if node.ParentID != "" {
			t.Fatalf("invalid self/forward parent must be rejected: %+v", node)
		}
	}
}

func TestSessionCallBErrorsConsumeReattachmentBudget(t *testing.T) {
	var mu sync.Mutex
	callsByNode := make(map[string]int)
	caller := scriptedCaller{
		a: func(turn Turn) (CallAResult, error) {
			return CallAResult{
				Topic: CallATopic{IsNew: turn.SegmentIndex == 0, Title: "인증"},
				Nodes: []CallANode{{Type: KindQuestion, Text: "질문", Quote: turn.Text}},
			}, nil
		},
		b: func(node *Node) (CallBResult, error) {
			mu.Lock()
			callsByNode[node.ID]++
			mu.Unlock()
			return CallBResult{}, errors.New("provider down")
		},
	}
	manager := newTestManager(t, caller, ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	for index := 0; index < 6; index++ {
		session.Enqueue(string(rune('a'+index)), "s", "질문 내용", float64(index), float64(index+1))
	}
	session.Finalize()
	mu.Lock()
	defer mu.Unlock()
	if callsByNode["n01"] != maxReattachTrie {
		t.Fatalf("first orphan got %d Call B invocations, want %d", callsByNode["n01"], maxReattachTrie)
	}
}

func TestSessionDuplicateTurnIDIgnored(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	first, err := session.Enqueue("dup", "s", "인증 방식 결정합시다", 0, 1)
	if err != nil || !first.Accepted {
		t.Fatalf("first enqueue should be accepted: %+v %v", first, err)
	}
	second, err := session.Enqueue("dup", "s", "다시 같은 턴", 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if second.Accepted || !second.Duplicate {
		t.Fatalf("duplicate turnId should be ignored idempotently: %+v", second)
	}
}

func TestSessionMailboxOverflowReturns429Error(t *testing.T) {
	release := make(chan struct{})
	caller := scriptedCaller{
		a: func(turn Turn) (CallAResult, error) {
			<-release
			return CallAResult{Topic: CallATopic{IsNew: true, Title: "t"}}, nil
		},
		b: func(node *Node) (CallBResult, error) { return CallBResult{}, nil },
	}
	manager := newTestManager(t, caller, ManagerOptions{MailboxSize: 1})
	session, _ := manager.Create("t", "", nil)

	overflow := false
	for index := 0; index < 6; index++ {
		_, err := session.Enqueue("turn-"+string(rune('a'+index)), "s", "발화 내용", 0, 1)
		if errors.Is(err, ErrMailboxFull) {
			overflow = true
			break
		}
	}
	close(release)
	if !overflow {
		t.Fatal("expected ErrMailboxFull once the mailbox filled")
	}
}

func TestSessionFinalizedRejectsTurns(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	session.Finalize()
	if _, err := session.Enqueue("late", "s", "늦은 턴", 0, 1); !errors.Is(err, ErrFinalized) {
		t.Fatalf("expected ErrFinalized, got %v", err)
	}
}

func TestSessionFinalizeIdempotentAndDrains(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{})
	session, _ := manager.Create("t", "", nil)
	session.Enqueue("t1", "s", "인증 방식 결정합시다", 0, 1)
	session.Enqueue("t2", "s", "OAuth 도입하죠", 1, 2)
	first := session.Finalize()
	second := session.Finalize()
	if first.Seq != second.Seq {
		t.Fatalf("finalize not idempotent: seq %d vs %d", first.Seq, second.Seq)
	}
	if first.Status != StatusFinalized || second.Status != StatusFinalized {
		t.Fatalf("status should be finalized on both calls")
	}
	// Both queued turns were drained before finalize.
	if len(first.Result.Topics) != 1 || len(first.Result.Topics[0].Nodes) != 2 {
		t.Fatalf("finalize must drain the mailbox: %+v", first.Result)
	}
}

func TestSessionDeltaBufferOverflowTriggersResync(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{MaxEvents: 2})
	session, _ := manager.Create("t", "", nil)
	session.Enqueue("t1", "s", "인증 방식 결정합시다", 0, 1)
	session.Enqueue("t2", "s", "OAuth 도입하죠", 1, 2)
	session.Finalize()

	stale := session.Snapshot(0)
	if !stale.Resync || len(stale.Deltas) != 0 {
		t.Fatalf("stale cursor should resync with empty deltas: %+v", eventTypes(stale.Deltas))
	}
	if len(stale.Result.Topics) == 0 {
		t.Fatalf("resync response must still carry the result")
	}
	// A cursor within the retained window is served without a resync.
	fresh := session.Snapshot(stale.Seq - 1)
	if fresh.Resync {
		t.Fatalf("in-window cursor should not resync: %+v", fresh)
	}
}

func TestManagerSessionCapacity(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{MaxSessions: 1})
	if _, err := manager.Create("t", "", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Create("t", "", nil); !errors.Is(err, ErrSessionCapacity) {
		t.Fatalf("expected ErrSessionCapacity, got %v", err)
	}
}

func TestManagerTenantIsolation(t *testing.T) {
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{})
	session, _ := manager.Create("tenant-A", "", nil)
	if _, ok := manager.Get(session.ID(), "tenant-B"); ok {
		t.Fatal("tenant B must not resolve tenant A's session")
	}
	if _, ok := manager.Get(session.ID(), "tenant-A"); !ok {
		t.Fatal("owning tenant must resolve its session")
	}
	if manager.Delete(session.ID(), "tenant-B") {
		t.Fatal("tenant B must not delete tenant A's session")
	}
	if !manager.Delete(session.ID(), "tenant-A") {
		t.Fatal("owning tenant must delete its session")
	}
}

func TestAcceptedTurnRefreshesIdleDeadline(t *testing.T) {
	base := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	var clockMu sync.Mutex
	current := base
	now := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return current
	}
	setNow := func(next time.Time) {
		clockMu.Lock()
		current = next
		clockMu.Unlock()
	}
	release := make(chan struct{})
	caller := scriptedCaller{
		a: func(turn Turn) (CallAResult, error) {
			<-release
			return CallAResult{Topic: CallATopic{IsNew: true, Title: "t"}}, nil
		},
		b: func(node *Node) (CallBResult, error) { return CallBResult{}, nil },
	}
	manager := newTestManager(t, caller, ManagerOptions{IdleTTL: 30 * time.Minute, Now: now})
	session, _ := manager.Create("t", "", nil)
	setNow(base.Add(29 * time.Minute))
	if _, err := session.Enqueue("turn", "s", "발화", 0, 1); err != nil {
		t.Fatal(err)
	}
	setNow(base.Add(31 * time.Minute))
	manager.sweep(now())
	if snap := session.Snapshot(0); snap.Status != StatusActive {
		t.Fatalf("turn accepted two minutes ago must keep session active, got %s", snap.Status)
	}
	close(release)
	session.Finalize()
}

func TestManagerJanitorEvictsIdleThenFinalized(t *testing.T) {
	base := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	var clockMu sync.Mutex
	current := base
	now := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return current
	}
	setNow := func(next time.Time) {
		clockMu.Lock()
		current = next
		clockMu.Unlock()
	}
	manager := newTestManager(t, twoTurnCaller(), ManagerOptions{
		IdleTTL:      30 * time.Minute,
		FinalizedTTL: 10 * time.Minute,
		Now:          now,
	})
	session, _ := manager.Create("t", "", nil)

	// Not yet idle.
	setNow(base.Add(20 * time.Minute))
	manager.sweep(now())
	if _, ok := manager.Get(session.ID(), "t"); !ok {
		t.Fatal("session should survive before idle TTL")
	}

	// Past idle TTL -> auto-finalized, retained.
	setNow(base.Add(31 * time.Minute))
	manager.sweep(now())
	got, ok := manager.Get(session.ID(), "t")
	if !ok {
		t.Fatal("idle session should be finalized but retained")
	}
	if snap := got.Snapshot(0); snap.Status != StatusFinalized {
		t.Fatalf("idle session should be finalized, got %q", snap.Status)
	}

	// Past finalized TTL -> dropped.
	setNow(base.Add(31*time.Minute + 11*time.Minute))
	manager.sweep(now())
	if _, ok := manager.Get(session.ID(), "t"); ok {
		t.Fatal("finalized session should be dropped after its retention")
	}
}
