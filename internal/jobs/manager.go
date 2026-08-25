package jobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"github.com/BeUnicorn2026/voice-partition-back/internal/meetmap"
)

type Status string

const (
	Queued    Status = "queued"
	Running   Status = "running"
	Succeeded Status = "succeeded"
	Failed    Status = "failed"
)

type Job struct {
	ID        string          `json:"id"`
	Status    Status          `json:"status"`
	MeetingID string          `json:"meetingId,omitempty"`
	TenantKey string          `json:"-"`
	Result    *meetmap.Result `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
	segments  []meetmap.Segment
}

type Manager struct {
	analyzer meetmap.Analyzer
	queue    chan string
	mu       sync.RWMutex
	jobs     map[string]*Job
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

func New(analyzer meetmap.Analyzer, workers, queueSize int) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	manager := &Manager{analyzer: analyzer, queue: make(chan string, queueSize), jobs: make(map[string]*Job), cancel: cancel}
	for worker := 0; worker < workers; worker++ {
		manager.wg.Add(1)
		go manager.run(ctx)
	}
	return manager
}

func (manager *Manager) Submit(request meetmap.Request) (Job, error) {
	segments, err := meetmap.NormalizeSegments(request.Segments)
	if err != nil {
		return Job{}, err
	}
	now := time.Now().UTC()
	job := &Job{ID: newID(), Status: Queued, MeetingID: request.MeetingID, TenantKey: request.TenantKey, CreatedAt: now, UpdatedAt: now, segments: segments}
	manager.mu.Lock()
	manager.jobs[job.ID] = job
	submitted := public(*job)
	manager.mu.Unlock()
	select {
	case manager.queue <- job.ID:
		return submitted, nil
	default:
		manager.mu.Lock()
		delete(manager.jobs, job.ID)
		manager.mu.Unlock()
		return Job{}, fmt.Errorf("분석 대기열이 가득 찼습니다")
	}
}

func (manager *Manager) Get(id, tenantKey string) (Job, bool) {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	job, ok := manager.jobs[id]
	if !ok || job.TenantKey != tenantKey {
		return Job{}, false
	}
	return public(*job), true
}

func (manager *Manager) Close() {
	manager.cancel()
	manager.wg.Wait()
}

func (manager *Manager) run(ctx context.Context) {
	defer manager.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-manager.queue:
			manager.process(ctx, id)
		}
	}
}

func (manager *Manager) process(ctx context.Context, id string) {
	manager.mu.Lock()
	job := manager.jobs[id]
	if job == nil {
		manager.mu.Unlock()
		return
	}
	job.Status = Running
	job.UpdatedAt = time.Now().UTC()
	segments := append([]meetmap.Segment(nil), job.segments...)
	manager.mu.Unlock()
	result, err := manager.analyzer.Analyze(ctx, segments)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	job = manager.jobs[id]
	if job == nil {
		return
	}
	job.UpdatedAt = time.Now().UTC()
	job.segments = nil
	if err != nil {
		job.Status = Failed
		job.Error = err.Error()
		return
	}
	job.Status = Succeeded
	job.Result = &result
}

func public(job Job) Job {
	job.segments = nil
	return job
}

func newID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return "map_" + hex.EncodeToString(buffer)
}
