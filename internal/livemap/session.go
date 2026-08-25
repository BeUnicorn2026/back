package livemap

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"
)

// Manager caps and defaults.
const (
	defaultMaxSessions  = 64
	defaultMailboxSize  = 256
	defaultMaxEvents    = 500
	defaultIdleTTL      = 30 * time.Minute
	defaultFinalizedTTL = 10 * time.Minute
	defaultJanitorEvery = time.Minute
)

// Session status values.
const (
	StatusActive    = "active"
	StatusFinalized = "finalized"
)

// Errors returned by the Manager and Session, mapped to HTTP status by the API.
var (
	// ErrSessionCapacity is returned when the per-process session cap is hit.
	ErrSessionCapacity = errors.New("livemap session capacity reached")
	// ErrMailboxFull is returned when a session's pending-turn buffer is full.
	ErrMailboxFull = errors.New("livemap session mailbox full")
	// ErrFinalized is returned when enqueuing to a finalized session.
	ErrFinalized = errors.New("livemap session finalized")
)

// Event is one entry in a session's ordered delta log. The JSON shape is a
// pinned cross-component contract; only the field for the event type is set.
type Event struct {
	Seq   int64       `json:"seq"`
	Type  string      `json:"type"`
	Topic *TopicEvent `json:"topic,omitempty"`
	Node  *NodeEvent  `json:"node,omitempty"`
	Link  *LinkEvent  `json:"link,omitempty"`
}

// TopicEvent is the payload of a topic_started event.
type TopicEvent struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	OffAgenda bool   `json:"offAgenda"`
}

// NodeEvent is the payload of a node_added event.
type NodeEvent struct {
	ID           string `json:"id"`
	TopicID      string `json:"topicId"`
	Kind         string `json:"kind"`
	Summary      string `json:"summary"`
	Speaker      string `json:"speaker"`
	TurnID       string `json:"turnId"`
	SegmentIndex int    `json:"segmentIndex"`
}

// LinkEvent is the payload of a link_added event.
type LinkEvent struct {
	NodeID        string  `json:"nodeId"`
	ParentID      string  `json:"parentId"`
	Relation      string  `json:"relation"`
	RelationLabel string  `json:"relationLabel"`
	Confidence    float64 `json:"confidence"`
}

// SessionMetrics augments the core validation counters with LLM call failures.
type SessionMetrics struct {
	CounterSnapshot
	CallAFailures uint64 `json:"callAFailures"`
	CallBFailures uint64 `json:"callBFailures"`
}

// Snapshot is the GET view of a session at a sinceSeq cursor.
type Snapshot struct {
	ID     string
	Status string
	Seq    int64
	Resync bool
	Deltas []Event
	Result MeetMapResult
}

// FinalizeResult is returned by Session.Finalize.
type FinalizeResult struct {
	ID      string
	Status  string
	Seq     int64
	Result  MeetMapResult
	Metrics SessionMetrics
}

// EnqueueResult reports the outcome of accepting a turn.
type EnqueueResult struct {
	Accepted  bool
	Duplicate bool
	Queued    int
}

// ManagerOptions configures caps and injectable clocks/intervals for testing.
type ManagerOptions struct {
	MaxSessions  int
	MailboxSize  int
	MaxEvents    int
	IdleTTL      time.Duration
	FinalizedTTL time.Duration
	JanitorEvery time.Duration
	Now          func() time.Time
}

func (o ManagerOptions) withDefaults() ManagerOptions {
	if o.MaxSessions <= 0 {
		o.MaxSessions = defaultMaxSessions
	}
	if o.MailboxSize <= 0 {
		o.MailboxSize = defaultMailboxSize
	}
	if o.MaxEvents <= 0 {
		o.MaxEvents = defaultMaxEvents
	}
	if o.IdleTTL <= 0 {
		o.IdleTTL = defaultIdleTTL
	}
	if o.FinalizedTTL <= 0 {
		o.FinalizedTTL = defaultFinalizedTTL
	}
	if o.JanitorEvery <= 0 {
		o.JanitorEvery = defaultJanitorEvery
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// Manager owns the set of live sessions and the idle/finalized janitor.
type Manager struct {
	caller Caller
	opts   ManagerOptions

	mu       sync.Mutex
	sessions map[string]*Session

	stop      chan struct{}
	janitorWG sync.WaitGroup
	closeOnce sync.Once
}

// NewManager starts a Manager with the given Caller and options.
func NewManager(caller Caller, opts ManagerOptions) *Manager {
	manager := &Manager{
		caller:   caller,
		opts:     opts.withDefaults(),
		sessions: make(map[string]*Session),
		stop:     make(chan struct{}),
	}
	manager.janitorWG.Add(1)
	go manager.janitor()
	return manager
}

// Create allocates a new session owned by tenant.
func (m *Manager) Create(tenant, meetingID string, agenda []string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessions) >= m.opts.MaxSessions {
		return nil, ErrSessionCapacity
	}
	session := newSession(m, newSessionID(), tenant, meetingID, agenda)
	m.sessions[session.id] = session
	go session.run()
	return session, nil
}

// Get returns the session if it exists and belongs to tenant.
func (m *Manager) Get(id, tenant string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[id]
	if !ok || session.tenant != tenant {
		return nil, false
	}
	return session, true
}

// Delete finalizes and removes a session. It returns false for an unknown id or
// a tenant mismatch (no existence leak).
func (m *Manager) Delete(id, tenant string) bool {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if !ok || session.tenant != tenant {
		m.mu.Unlock()
		return false
	}
	delete(m.sessions, id)
	m.mu.Unlock()
	session.Finalize()
	return true
}

// Close stops the janitor and finalizes every remaining session.
func (m *Manager) Close() {
	m.closeOnce.Do(func() {
		close(m.stop)
		m.mu.Lock()
		sessions := make([]*Session, 0, len(m.sessions))
		for _, session := range m.sessions {
			sessions = append(sessions, session)
		}
		m.sessions = make(map[string]*Session)
		m.mu.Unlock()
		for _, session := range sessions {
			session.Finalize()
		}
		m.janitorWG.Wait()
	})
}

func (m *Manager) janitor() {
	defer m.janitorWG.Done()
	ticker := time.NewTicker(m.opts.JanitorEvery)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
			m.sweep(m.opts.Now())
		}
	}
}

// sweep auto-finalizes idle sessions and drops finalized sessions past their
// retention. It is called by the janitor and directly by tests.
func (m *Manager) sweep(now time.Time) {
	m.mu.Lock()
	var toFinalize []*Session
	for id, session := range m.sessions {
		session.mu.Lock()
		status, last, finalizedAt := session.status, session.lastActivity, session.finalizedAt
		session.mu.Unlock()
		switch {
		case status == StatusFinalized:
			if now.Sub(finalizedAt) >= m.opts.FinalizedTTL {
				delete(m.sessions, id)
			}
		case now.Sub(last) >= m.opts.IdleTTL:
			toFinalize = append(toFinalize, session)
		}
	}
	m.mu.Unlock()
	for _, session := range toFinalize {
		session.Finalize()
	}
}

type turnJob struct {
	turnID  string
	speaker string
	text    string
	start   float64
	end     float64
}

// Session is one live IBIS tree driven by a single actor goroutine.
type Session struct {
	id        string
	tenant    string
	meetingID string
	manager   *Manager
	caller    Caller
	maxEvents int
	now       func() time.Time

	mailbox chan turnJob
	done    chan struct{}

	mu            sync.Mutex
	state         *State
	status        string
	seq           int64
	events        []Event
	segmentIndex  int
	seenTurns     map[string]bool
	announced     map[string]bool
	result        MeetMapResult
	metrics       SessionMetrics
	callAFailures uint64
	callBFailures uint64
	lastActivity  time.Time
	finalizedAt   time.Time
	closed        bool
	agenda        []string
}

func newSession(manager *Manager, id, tenant, meetingID string, agenda []string) *Session {
	now := manager.opts.Now
	session := &Session{
		id:           id,
		tenant:       tenant,
		meetingID:    meetingID,
		manager:      manager,
		caller:       manager.caller,
		maxEvents:    manager.opts.MaxEvents,
		now:          now,
		mailbox:      make(chan turnJob, manager.opts.MailboxSize),
		done:         make(chan struct{}),
		state:        NewState(),
		status:       StatusActive,
		seenTurns:    make(map[string]bool),
		announced:    make(map[string]bool),
		result:       MeetMapResult{Topics: []MeetMapTopic{}},
		lastActivity: now(),
		agenda:       append([]string(nil), agenda...),
	}
	return session
}

// ID returns the opaque session id.
func (s *Session) ID() string { return s.id }

// Tenant returns the owning tenant key.
func (s *Session) Tenant() string { return s.tenant }

// Enqueue accepts a turn for asynchronous processing. Duplicate turnIds are
// ignored idempotently.
func (s *Session) Enqueue(turnID, speaker, text string, start, end float64) (EnqueueResult, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return EnqueueResult{}, ErrFinalized
	}
	if s.seenTurns[turnID] {
		s.mu.Unlock()
		return EnqueueResult{Accepted: false, Duplicate: true}, nil
	}
	job := turnJob{turnID: turnID, speaker: speaker, text: text, start: start, end: end}
	select {
	case s.mailbox <- job:
		s.seenTurns[turnID] = true
		// Idleness is measured from accepted input, not from when LLM work
		// eventually completes.
		s.lastActivity = s.now()
		queued := len(s.mailbox)
		s.mu.Unlock()
		return EnqueueResult{Accepted: true, Queued: queued}, nil
	default:
		s.mu.Unlock()
		return EnqueueResult{}, ErrMailboxFull
	}
}

// Snapshot returns the deltas after sinceSeq (or a resync signal if that cursor
// predates the retained buffer) alongside the current result.
func (s *Session) Snapshot(sinceSeq int64) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	snap := Snapshot{ID: s.id, Status: s.status, Seq: s.seq, Result: s.result, Deltas: []Event{}}
	if len(s.events) == 0 {
		return snap
	}
	floor := s.events[0].Seq
	if sinceSeq < floor-1 {
		snap.Resync = true
		return snap
	}
	for _, event := range s.events {
		if event.Seq > sinceSeq {
			snap.Deltas = append(snap.Deltas, event)
		}
	}
	return snap
}

// Finalize stops accepting turns, drains the mailbox, emits the finalized delta,
// and returns the final result and metrics. It is idempotent.
func (s *Session) Finalize() FinalizeResult {
	s.stopAccepting()
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	return FinalizeResult{ID: s.id, Status: s.status, Seq: s.seq, Result: s.result, Metrics: s.metrics}
}

func (s *Session) stopAccepting() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	close(s.mailbox)
	s.mu.Unlock()
}

// run is the single actor goroutine: it consumes the mailbox strictly in order,
// then performs finalize bookkeeping once the mailbox is closed and drained.
func (s *Session) run() {
	for job := range s.mailbox {
		s.handleTurn(job)
	}
	s.finish()
	close(s.done)
}

func (s *Session) handleTurn(job turnJob) {
	ctx := context.Background()

	// Phase 1: assign a segment index and render the Call A user message.
	s.mu.Lock()
	segment := s.segmentIndex
	s.segmentIndex++
	userMessageA := s.buildCallAMessageLocked(job)
	state := s.state
	s.mu.Unlock()

	turn := Turn{Speaker: job.speaker, Text: job.text, SegmentIndex: segment, Start: job.start, End: job.end}

	aResult, err := s.caller.CallA(ctx, userMessageA, state, turn)
	if err != nil {
		// Call A failure never fails the session; record it and move on.
		s.mu.Lock()
		s.callAFailures++
		s.mu.Unlock()
		return
	}

	// Phase 2: apply Call A, emit topic/node deltas, capture reattach work.
	s.mu.Lock()
	prevTopics := len(s.state.Topics)
	delta := ApplyCallA(s.state, turn, aResult)
	if len(s.state.Topics) > prevTopics {
		MarkTopicBoundary(s.state)
	}
	topicID := ""
	if delta.Topic != nil {
		topicID = delta.Topic.ID
		if !s.announced[topicID] {
			s.announced[topicID] = true
			s.appendEventLocked(Event{Type: "topic_started", Topic: &TopicEvent{
				ID: delta.Topic.ID, Label: delta.Topic.Label, OffAgenda: delta.Topic.OffAgenda,
			}})
		}
	}
	for _, node := range delta.Nodes {
		s.appendEventLocked(Event{Type: "node_added", Node: &NodeEvent{
			ID: node.ID, TopicID: topicID, Kind: node.Kind, Summary: node.Summary,
			Speaker: job.speaker, TurnID: job.turnID, SegmentIndex: node.SegmentIndex,
		}})
	}
	needCallB := NeedsCallB(s.state)
	candidateIDs := make([]string, 0)
	if needCallB {
		for _, node := range ReattachCandidates(s.state) {
			candidateIDs = append(candidateIDs, node.ID)
		}
	}
	s.refreshResultLocked()
	s.mu.Unlock()

	// Phase 3: for each orphan candidate, run Call B and apply the result.
	if needCallB {
		for _, id := range candidateIDs {
			s.reattach(ctx, id)
		}
	}

}

func (s *Session) reattach(ctx context.Context, nodeID string) {
	s.mu.Lock()
	node := s.state.Nodes[nodeID]
	if node == nil || !node.Orphan {
		s.mu.Unlock()
		return
	}
	userMessageB := BuildUserMessageB(CallBInput{
		Tree:  SerializeTreeForCallB(s.state),
		Type:  node.Kind,
		Text:  node.Text,
		Quote: node.Quote,
	})
	state := s.state
	// Copy the node so the network call touches no shared state.
	nodeCopy := *node
	s.mu.Unlock()

	bResult, err := s.caller.CallB(ctx, userMessageB, state, &nodeCopy)
	if err != nil {
		s.mu.Lock()
		s.callBFailures++
		if current := s.state.Nodes[nodeID]; current != nil && current.Orphan && current.ReattachTries < maxReattachTrie {
			// A failed Call B invocation consumes one orphan reattachment
			// attempt. The OpenRouter caller already applies its one HTTP retry.
			current.ReattachTries++
		}
		s.mu.Unlock()
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.state.Nodes[nodeID]
	if current == nil {
		return
	}
	if !validParentSelection(s.state, current, bResult) {
		// Keep the normal P1 rejection/counter behavior while preventing links
		// that cannot be part of a preceding-parent tree.
		if bResult.ParentID != nil {
			invalid := ""
			bResult.ParentID = &invalid
		}
	}
	ApplyCallB(s.state, nodeID, bResult)
	if attached := s.state.Nodes[nodeID]; attached != nil && !attached.Orphan {
		s.state.Counters.reattachment()
		s.appendEventLocked(Event{Type: "link_added", Link: &LinkEvent{
			NodeID:        attached.ID,
			ParentID:      attached.ParentID,
			Relation:      attached.Relation,
			RelationLabel: relationLabel(attached.Relation),
			Confidence:    attached.Confidence,
		}})
	}
	s.refreshResultLocked()
}

// validParentSelection enforces the incremental tree invariant that a node may
// only attach to an earlier node. This excludes self-links, forward links, and
// cycles without changing the frozen P1 validation API.
func validParentSelection(state *State, node *Node, result CallBResult) bool {
	if result.ParentID == nil {
		return true
	}
	parentID := strings.TrimSpace(*result.ParentID)
	if parentID == "" || parentID == node.ID {
		return false
	}
	parent := state.Nodes[parentID]
	return parent != nil && parent.SegmentIndex < node.SegmentIndex
}

func (s *Session) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == StatusFinalized {
		return
	}
	MarkTopicBoundary(s.state)
	s.status = StatusFinalized
	s.finalizedAt = s.now()
	s.appendEventLocked(Event{Type: "finalized"})
	s.refreshResultLocked()
	s.metrics = s.snapshotMetricsLocked()
}

// buildCallAMessageLocked renders the Call A user message from current state.
// The caller must hold s.mu.
func (s *Session) buildCallAMessageLocked(job turnJob) string {
	topicID, topicTitle := "", ""
	if count := len(s.state.Topics); count > 0 {
		current := s.state.Topics[count-1]
		topicID, topicTitle = current.ID, current.Label
	}
	return BuildUserMessageA(CallAInput{
		Agenda:            strings.Join(s.agenda, "\n"),
		CurrentTopicID:    topicID,
		CurrentTopicTitle: topicTitle,
		PrevTurns:         formatPrevTurns(s.state.PrevTurns),
		Tree:              SerializeTree(s.state),
		Speaker:           job.speaker,
		Utterance:         job.text,
	})
}

func formatPrevTurns(turns []Turn) string {
	if len(turns) == 0 {
		return ""
	}
	var builder strings.Builder
	for index, turn := range turns {
		if index > 0 {
			builder.WriteByte('\n')
		}
		speaker := turn.Speaker
		if strings.TrimSpace(speaker) == "" {
			speaker = "화자"
		}
		builder.WriteString(speaker)
		builder.WriteString(": ")
		builder.WriteString(turn.Text)
	}
	return builder.String()
}

// appendEventLocked assigns the next seq, appends the event, and trims the ring
// to the retention cap. The caller must hold s.mu.
func (s *Session) appendEventLocked(event Event) {
	s.seq++
	event.Seq = s.seq
	s.events = append(s.events, event)
	if len(s.events) > s.maxEvents {
		s.events = s.events[len(s.events)-s.maxEvents:]
	}
}

func (s *Session) refreshResultLocked() {
	s.result = ToMeetMapResult(s.state)
}

func (s *Session) snapshotMetricsLocked() SessionMetrics {
	return SessionMetrics{
		CounterSnapshot: s.state.Counters.Snapshot(),
		CallAFailures:   s.callAFailures,
		CallBFailures:   s.callBFailures,
	}
}

func newSessionID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return "lm_" + hex.EncodeToString(buffer)
}
