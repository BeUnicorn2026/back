package livemap

import "sync"

// CounterSnapshot is an immutable copy of validation and tree-health metrics.
type CounterSnapshot struct {
	Violations    map[string]uint64 `json:"violations"`
	Truncations   uint64            `json:"truncations"`
	Clamps        uint64            `json:"clamps"`
	Orphans       uint64            `json:"orphans"`
	Reattachments uint64            `json:"reattachments"`
}

// Counters stores concurrent-safe validation and tree-health counters.
type Counters struct {
	mu            sync.Mutex
	violations    map[string]uint64
	truncations   uint64
	clamps        uint64
	orphans       uint64
	reattachments uint64
}

// NewCounters creates an initialized counter collection.
func NewCounters() *Counters {
	return &Counters{violations: make(map[string]uint64)}
}

func (c *Counters) violation(rule string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.violations == nil {
		c.violations = make(map[string]uint64)
	}
	c.violations[rule]++
}

func (c *Counters) truncation(rule string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.violations == nil {
		c.violations = make(map[string]uint64)
	}
	c.violations[rule]++
	c.truncations++
}

func (c *Counters) clamp() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.violations == nil {
		c.violations = make(map[string]uint64)
	}
	c.violations["B-V5"]++
	c.clamps++
}

func (c *Counters) orphan() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.orphans++
}

func (c *Counters) reattachment() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reattachments++
}

// Snapshot returns an independent copy safe for callers to retain and mutate.
func (c *Counters) Snapshot() CounterSnapshot {
	if c == nil {
		return CounterSnapshot{Violations: map[string]uint64{}}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	violations := make(map[string]uint64, len(c.violations))
	for rule, count := range c.violations {
		violations[rule] = count
	}
	return CounterSnapshot{
		Violations:    violations,
		Truncations:   c.truncations,
		Clamps:        c.clamps,
		Orphans:       c.orphans,
		Reattachments: c.reattachments,
	}
}
