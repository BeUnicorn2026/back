package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const DefaultOpenRouterModel = "stealth/ox-alpha"

type Config struct {
	Host              string
	Port              int
	PublicOrigin      string
	OpenRouterAPIKey  string
	OpenRouterBaseURL string
	OpenRouterModel   string
	OpenRouterTimeout time.Duration
	AIAPIToken        string
	WorkerCount       int
	QueueSize         int
	MaximumBodyBytes  int64
}

func Load() (Config, error) {
	cfg := Config{
		Host:              value("GO_HOST", "127.0.0.1"),
		Port:              integer("GO_PORT", 7071),
		PublicOrigin:      strings.TrimSpace(os.Getenv("PUBLIC_ORIGIN")),
		OpenRouterAPIKey:  strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY")),
		OpenRouterBaseURL: value("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
		OpenRouterModel:   value("OPENROUTER_MODEL", DefaultOpenRouterModel),
		OpenRouterTimeout: time.Duration(integer("OPENROUTER_TIMEOUT_SECONDS", 90)) * time.Second,
		AIAPIToken:        strings.TrimSpace(os.Getenv("AI_API_TOKEN")),
		WorkerCount:       integer("AI_WORKER_COUNT", 4),
		QueueSize:         integer("AI_QUEUE_SIZE", 64),
		MaximumBodyBytes:  int64(integer("AI_MAXIMUM_BODY_BYTES", 1<<20)),
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return Config{}, fmt.Errorf("GO_PORT must be between 1 and 65535")
	}
	if cfg.WorkerCount < 1 || cfg.WorkerCount > 32 {
		return Config{}, fmt.Errorf("AI_WORKER_COUNT must be between 1 and 32")
	}
	if cfg.QueueSize < cfg.WorkerCount || cfg.QueueSize > 4096 {
		return Config{}, fmt.Errorf("AI_QUEUE_SIZE must be between AI_WORKER_COUNT and 4096")
	}
	return cfg, nil
}

func value(name, fallback string) string {
	if candidate := strings.TrimSpace(os.Getenv(name)); candidate != "" {
		return candidate
	}
	return fallback
}

func integer(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
