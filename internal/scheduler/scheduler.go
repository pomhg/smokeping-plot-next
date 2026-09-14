// Package scheduler runs one probe loop per enabled target, aligned to the
// target's step so samples land on predictable timestamps.
package scheduler

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/pomhg/smokeping-plot-next/internal/probe"
	"github.com/pomhg/smokeping-plot-next/internal/store"
)

type Scheduler struct {
	st       *store.Store
	opt      probe.Options
	onSample func(store.Sample)

	mu      sync.Mutex
	runners map[int64]*runner
}

type runner struct {
	target store.Target
	cancel context.CancelFunc
}

func New(st *store.Store, opt probe.Options, onSample func(store.Sample)) *Scheduler {
	return &Scheduler{st: st, opt: opt, onSample: onSample, runners: map[int64]*runner{}}
}

// Sync reconciles running probe loops with the targets table: it starts
// loops for new/enabled targets, stops loops for deleted/disabled ones and
// restarts loops whose probe parameters changed.
func (s *Scheduler) Sync(ctx context.Context) error {
	targets, err := s.st.ListTargets(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	want := map[int64]store.Target{}
	for _, t := range targets {
		if t.Enabled {
			want[t.ID] = t
		}
	}
	for id, r := range s.runners {
		t, ok := want[id]
		if !ok || probeParamsChanged(r.target, t) {
			r.cancel()
			delete(s.runners, id)
		}
	}
	for id, t := range want {
		if _, ok := s.runners[id]; ok {
			continue
		}
		rctx, cancel := context.WithCancel(context.Background())
		s.runners[id] = &runner{target: t, cancel: cancel}
		go s.loop(rctx, t)
	}
	return nil
}

func (s *Scheduler) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, r := range s.runners {
		r.cancel()
		delete(s.runners, id)
	}
}

func probeParamsChanged(a, b store.Target) bool {
	return a.Host != b.Host || a.Probe != b.Probe || a.Port != b.Port || a.Step != b.Step || a.Pings != b.Pings
}

func (s *Scheduler) loop(ctx context.Context, t store.Target) {
	step := int64(t.Step)
	log := slog.With("target", t.Name, "host", t.Host)
	log.Info("probe loop started", "probe", t.Probe, "step", t.Step, "pings", t.Pings)
	defer log.Info("probe loop stopped")

	// Spread the initial rounds a little so a fresh start with many targets
	// does not fire everything in the same instant.
	jitter := time.Duration(rand.IntN(2000)) * time.Millisecond
	select {
	case <-ctx.Done():
		return
	case <-time.After(jitter):
	}

	ts := time.Now().Unix() / step * step
	for {
		s.round(ctx, t, ts)

		next := ts + step
		wait := time.Until(time.Unix(next, 0))
		if wait < 0 {
			// The round took longer than the step (very lossy target); skip
			// ahead instead of piling up.
			next = time.Now().Unix()/step*step + step
			wait = time.Until(time.Unix(next, 0))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		ts = next
	}
}

func (s *Scheduler) round(ctx context.Context, t store.Target, ts int64) {
	res := probe.Run(ctx, probe.Request{Probe: t.Probe, Host: t.Host, Port: t.Port, Count: t.Pings}, s.opt)
	if ctx.Err() != nil {
		return
	}
	sm := store.NewSample(t.ID, ts, res.Sent, res.RTTs, res.Err)
	if err := s.st.InsertSample(context.Background(), sm); err != nil {
		slog.Error("insert sample", "err", err, "target", t.Name)
		return
	}
	if s.onSample != nil {
		s.onSample(sm)
	}
}
