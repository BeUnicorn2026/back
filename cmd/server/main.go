package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/BeUnicorn2026/voice-partition-back/internal/config"
	"github.com/BeUnicorn2026/voice-partition-back/internal/httpapi"
	"github.com/BeUnicorn2026/voice-partition-back/internal/jobs"
	"github.com/BeUnicorn2026/voice-partition-back/internal/livemap"
	"github.com/BeUnicorn2026/voice-partition-back/internal/meetmap"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	analyzer := meetmap.NewOpenRouter(cfg.OpenRouterAPIKey, cfg.OpenRouterBaseURL, cfg.OpenRouterModel, cfg.PublicOrigin, cfg.OpenRouterTimeout)
	manager := jobs.New(analyzer, cfg.WorkerCount, cfg.QueueSize)
	defer manager.Close()
	liveManager := livemap.NewManager(livemap.NewCaller(cfg.OpenRouterAPIKey, cfg.OpenRouterBaseURL, cfg.LivemapModel, cfg.PublicOrigin), livemap.ManagerOptions{})
	defer liveManager.Close()
	httpServer := httpapi.HTTPServer(fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), httpapi.New(cfg, manager, liveManager))
	go func() {
		slog.Info("Go migration API listening", "address", httpServer.Addr, "model", cfg.OpenRouterModel, "openrouter", cfg.OpenRouterAPIKey != "")
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("HTTP server stopped", "error", err)
			os.Exit(1)
		}
	}()
	stop, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	<-stop.Done()
	ctx, shutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdown()
	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "error", err)
	}
}
