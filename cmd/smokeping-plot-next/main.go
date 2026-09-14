// smokeping-plot-next – a self-contained latency monitor in the spirit of
// smokeping: periodic multi-ping probes, smoke graphs and a web UI.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pomhg/smokeping-plot-next/internal/api"
	"github.com/pomhg/smokeping-plot-next/internal/config"
	"github.com/pomhg/smokeping-plot-next/internal/probe"
	"github.com/pomhg/smokeping-plot-next/internal/scheduler"
	"github.com/pomhg/smokeping-plot-next/internal/store"
	"github.com/pomhg/smokeping-plot-next/web"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))

	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		slog.Error("create data dir", "err", err)
		os.Exit(1)
	}
	st, err := store.Open(cfg.DataDir)
	if err != nil {
		slog.Error("open database", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	po := probe.Options{
		Interval:   cfg.PingInterval,
		Timeout:    cfg.PingTimeout,
		Privileged: probe.DetectPrivileged(cfg.ProbePrivileged),
	}

	hub := api.NewHub()
	sched := scheduler.New(st, po, func(sm store.Sample) {
		sm.RTTs = nil // keep the event small
		hub.Broadcast("sample", sm)
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := sched.Sync(ctx); err != nil {
		slog.Error("start scheduler", "err", err)
		os.Exit(1)
	}
	go maintenance(ctx, st, cfg)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           api.New(cfg, st, sched, hub, po, version, web.Dist()).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		slog.Info("listening", "addr", cfg.Listen, "version", version, "data", cfg.DataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http server", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	sched.Stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}

// maintenance periodically consolidates raw samples into hourly rollups and
// prunes data beyond the retention windows.
func maintenance(ctx context.Context, st *store.Store, cfg *config.Config) {
	run := func() {
		now := time.Now()
		// Re-roll the last three hours so the current (partial) hour and any
		// late samples are covered.
		if err := st.Rollup(ctx, now.Add(-3*time.Hour).Unix()); err != nil {
			slog.Error("rollup", "err", err)
		}
		rawBefore := now.Add(-cfg.RawRetention).Unix()
		rollupBefore := now.Add(-cfg.RollupRetention).Unix()
		if err := st.Prune(ctx, rawBefore, rollupBefore); err != nil {
			slog.Error("prune", "err", err)
		}
	}
	// On startup, roll up everything that may have been missed while down.
	if err := st.Rollup(ctx, time.Now().Add(-cfg.RawRetention).Unix()); err != nil {
		slog.Error("initial rollup", "err", err)
	}
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}
