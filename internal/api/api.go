// Package api exposes the REST + SSE interface consumed by the web UI.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/pomhg/smokeping-plot-next/internal/config"
	"github.com/pomhg/smokeping-plot-next/internal/probe"
	"github.com/pomhg/smokeping-plot-next/internal/scheduler"
	"github.com/pomhg/smokeping-plot-next/internal/store"
)

type Server struct {
	cfg     *config.Config
	st      *store.Store
	sched   *scheduler.Scheduler
	hub     *Hub
	probe   probe.Options
	version string
	static  fs.FS
}

func New(cfg *config.Config, st *store.Store, sched *scheduler.Scheduler, hub *Hub, po probe.Options, version string, static fs.FS) *Server {
	return &Server{cfg: cfg, st: st, sched: sched, hub: hub, probe: po, version: version, static: static}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", s.getConfig)
	mux.HandleFunc("GET /api/stats", s.getStats)
	mux.HandleFunc("GET /api/targets", s.listTargets)
	mux.HandleFunc("POST /api/targets", s.createTarget)
	mux.HandleFunc("PUT /api/targets/order", s.reorderTargets)
	mux.HandleFunc("PUT /api/targets/{id}", s.updateTarget)
	mux.HandleFunc("DELETE /api/targets/{id}", s.deleteTarget)
	mux.HandleFunc("GET /api/targets/{id}/series", s.targetSeries)
	mux.HandleFunc("GET /api/series", s.multiSeries)
	mux.HandleFunc("POST /api/probe", s.probeOnce)
	mux.Handle("GET /api/events", s.hub)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "unknown endpoint")
	})
	mux.Handle("/", s.spa())

	var h http.Handler = mux
	if s.cfg.AuthUser != "" {
		h = s.basicAuth(h)
	}
	return logRequests(h)
}

// ---------------------------------------------------------------- helpers

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func pathID(r *http.Request) (int64, error) {
	return strconv.ParseInt(r.PathValue("id"), 10, 64)
}

func queryInt(r *http.Request, key string, def int64) int64 {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func (s *Server) basicAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(u), []byte(s.cfg.AuthUser)) != 1 ||
			subtle.ConstantTimeCompare([]byte(p), []byte(s.cfg.AuthPass)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="smokeping-plot-next"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/events" {
			start := time.Now()
			next.ServeHTTP(w, r)
			slog.Debug("http", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------- config

func (s *Server) getConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"version":             s.version,
		"defaultStep":         s.cfg.DefaultStep,
		"defaultPings":        s.cfg.DefaultPings,
		"pingIntervalMs":      s.cfg.PingInterval.Milliseconds(),
		"pingTimeoutMs":       s.cfg.PingTimeout.Milliseconds(),
		"rawRetentionDays":    int(s.cfg.RawRetention.Hours() / 24),
		"rollupRetentionDays": int(s.cfg.RollupRetention.Hours() / 24),
		"icmpPrivileged":      s.probe.Privileged,
		"authEnabled":         s.cfg.AuthUser != "",
	})
}

func (s *Server) getStats(w http.ResponseWriter, r *http.Request) {
	st, err := s.st.Stats(r.Context())
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, st)
}

// ---------------------------------------------------------------- targets

type targetView struct {
	store.Target
	Last *store.Sample `json:"last"`
}

func (s *Server) listTargets(w http.ResponseWriter, r *http.Request) {
	targets, err := s.st.ListTargets(r.Context())
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	latest, err := s.st.LatestSamples(r.Context())
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	out := make([]targetView, 0, len(targets))
	for _, t := range targets {
		tv := targetView{Target: t}
		if sm, ok := latest[t.ID]; ok {
			sm := sm
			tv.Last = &sm
		}
		out = append(out, tv)
	}
	writeJSON(w, 200, map[string]any{"targets": out})
}

type targetInput struct {
	Name      string `json:"name"`
	Host      string `json:"host"`
	Group     string `json:"group"`
	Probe     string `json:"probe"`
	Port      int    `json:"port"`
	Step      int    `json:"step"`
	Pings     int    `json:"pings"`
	Enabled   *bool  `json:"enabled"`
	SortOrder int    `json:"sortOrder"`
}

func (s *Server) validate(in targetInput, base store.Target) (store.Target, error) {
	t := base
	t.Host = strings.TrimSpace(in.Host)
	if t.Host == "" {
		return t, errors.New("host is required")
	}
	if strings.ContainsAny(t.Host, " /\\") {
		return t, errors.New("host must be a hostname or IP address")
	}
	t.Name = strings.TrimSpace(in.Name)
	if t.Name == "" {
		t.Name = t.Host
	}
	t.Group = strings.TrimSpace(in.Group)
	t.Probe = strings.ToLower(strings.TrimSpace(in.Probe))
	if t.Probe == "" {
		t.Probe = "icmp"
	}
	switch t.Probe {
	case "icmp":
		t.Port = 0
	case "tcp":
		if in.Port < 1 || in.Port > 65535 {
			return t, errors.New("tcp probe needs a port within 1..65535")
		}
		t.Port = in.Port
	default:
		return t, errors.New("probe must be icmp or tcp")
	}
	t.Step = in.Step
	if t.Step == 0 {
		t.Step = s.cfg.DefaultStep
	}
	if t.Step < 10 || t.Step > 86400 {
		return t, errors.New("step must be within 10..86400 seconds")
	}
	t.Pings = in.Pings
	if t.Pings == 0 {
		t.Pings = s.cfg.DefaultPings
	}
	if t.Pings < 1 || t.Pings > 100 {
		return t, errors.New("pings must be within 1..100")
	}
	// A round must fit inside the step with some headroom.
	roundDur := time.Duration(t.Pings)*s.probe.Interval + s.probe.Timeout
	if roundDur > time.Duration(t.Step)*time.Second {
		return t, errors.New("step is too short for the number of pings")
	}
	t.Enabled = true
	if in.Enabled != nil {
		t.Enabled = *in.Enabled
	}
	t.SortOrder = in.SortOrder
	return t, nil
}

func (s *Server) createTarget(w http.ResponseWriter, r *http.Request) {
	var in targetInput
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, 400, "invalid json: "+err.Error())
		return
	}
	t, err := s.validate(in, store.Target{})
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	t, err = s.st.CreateTarget(r.Context(), t)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.afterTargetChange()
	writeJSON(w, 201, t)
}

func (s *Server) updateTarget(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "bad id")
		return
	}
	existing, err := s.st.GetTarget(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "target not found")
		return
	} else if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	var in targetInput
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, 400, "invalid json: "+err.Error())
		return
	}
	t, err := s.validate(in, existing)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if err := s.st.UpdateTarget(r.Context(), t); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.afterTargetChange()
	writeJSON(w, 200, t)
}

func (s *Server) deleteTarget(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "bad id")
		return
	}
	err = s.st.DeleteTarget(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "target not found")
		return
	} else if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.afterTargetChange()
	w.WriteHeader(http.StatusNoContent)
}

// reorderTargets persists a drag-and-drop arrangement: each item's group and
// position. Only the listed targets are touched.
func (s *Server) reorderTargets(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Items []store.OrderItem `json:"items"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, 400, "invalid json: "+err.Error())
		return
	}
	if len(in.Items) == 0 || len(in.Items) > 1000 {
		writeErr(w, 400, "items must contain 1..1000 entries")
		return
	}
	for i := range in.Items {
		in.Items[i].Group = strings.TrimSpace(in.Items[i].Group)
	}
	if err := s.st.Reorder(r.Context(), in.Items); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.hub.Broadcast("targets", map[string]any{"ts": time.Now().Unix()})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) afterTargetChange() {
	if err := s.sched.Sync(context.Background()); err != nil {
		slog.Error("scheduler sync", "err", err)
	}
	s.hub.Broadcast("targets", map[string]any{"ts": time.Now().Unix()})
}

// ---------------------------------------------------------------- series

type seriesResp struct {
	TargetID int64         `json:"targetId"`
	From     int64         `json:"from"`
	To       int64         `json:"to"`
	Bucket   int64         `json:"bucket"`
	Source   string        `json:"source"`
	Points   []store.Point `json:"points"`
}

func (s *Server) seriesFor(ctx context.Context, t store.Target, from, to, points int64) (seriesResp, error) {
	now := time.Now().Unix()
	if to <= 0 || to > now+60 {
		to = now
	}
	if from <= 0 || from >= to {
		from = to - 3*3600
	}
	if points < 10 {
		points = 10
	}
	if points > 2000 {
		points = 2000
	}
	bucket := (to - from + points - 1) / points
	if bucket < int64(t.Step) {
		bucket = int64(t.Step)
	}
	useRollups := false
	rawEdge := now - int64(s.cfg.RawRetention.Seconds())
	if bucket >= 3600 || from < rawEdge {
		useRollups = true
		if bucket < 3600 {
			bucket = 3600
		}
	}
	// Whole buckets only, so the first/last points are not partially filled.
	from = from / bucket * bucket
	pts, err := s.st.Series(ctx, t.ID, from, to+bucket, bucket, useRollups)
	if err != nil {
		return seriesResp{}, err
	}
	src := "raw"
	if useRollups {
		src = "rollup"
	}
	return seriesResp{TargetID: t.ID, From: from, To: to, Bucket: bucket, Source: src, Points: pts}, nil
}

func (s *Server) targetSeries(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, "bad id")
		return
	}
	t, err := s.st.GetTarget(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "target not found")
		return
	} else if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	resp, err := s.seriesFor(r.Context(), t, queryInt(r, "from", 0), queryInt(r, "to", 0), queryInt(r, "points", 400))
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, resp)
}

// multiSeries returns series for several targets at once (overview page).
// ?ids=1,2,3 or omit for all targets.
func (s *Server) multiSeries(w http.ResponseWriter, r *http.Request) {
	targets, err := s.st.ListTargets(r.Context())
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	want := map[int64]bool{}
	if ids := r.URL.Query().Get("ids"); ids != "" {
		for _, p := range strings.Split(ids, ",") {
			if n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64); err == nil {
				want[n] = true
			}
		}
	}
	from, to, points := queryInt(r, "from", 0), queryInt(r, "to", 0), queryInt(r, "points", 120)
	out := map[string]seriesResp{}
	for _, t := range targets {
		if len(want) > 0 && !want[t.ID] {
			continue
		}
		resp, err := s.seriesFor(r.Context(), t, from, to, points)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		out[strconv.FormatInt(t.ID, 10)] = resp
	}
	writeJSON(w, 200, map[string]any{"series": out})
}

// ---------------------------------------------------------------- probe

func (s *Server) probeOnce(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Host  string `json:"host"`
		Probe string `json:"probe"`
		Port  int    `json:"port"`
		Count int    `json:"count"`
	}
	if err := readJSON(w, r, &in); err != nil {
		writeErr(w, 400, "invalid json: "+err.Error())
		return
	}
	in.Host = strings.TrimSpace(in.Host)
	if in.Host == "" {
		writeErr(w, 400, "host is required")
		return
	}
	if in.Probe == "" {
		in.Probe = "icmp"
	}
	if in.Count < 1 || in.Count > 10 {
		in.Count = 5
	}
	if in.Probe == "tcp" && (in.Port < 1 || in.Port > 65535) {
		writeErr(w, 400, "tcp probe needs a port")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	start := time.Now()
	res := probe.Run(ctx, probe.Request{Probe: in.Probe, Host: in.Host, Port: in.Port, Count: in.Count}, s.probe)
	sm := store.NewSample(0, start.Unix(), res.Sent, res.RTTs, res.Err)
	var resolved string
	if ips, err := net.DefaultResolver.LookupHost(ctx, in.Host); err == nil && len(ips) > 0 {
		resolved = ips[0]
	}
	writeJSON(w, 200, map[string]any{"sample": sm, "resolved": resolved, "durationMs": time.Since(start).Milliseconds()})
}

// ---------------------------------------------------------------- static

// spa serves the embedded frontend with history-API fallback.
func (s *Server) spa() http.Handler {
	fileServer := http.FileServer(http.FS(s.static))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := s.static.Open(p); err == nil {
			f.Close()
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		index, err := fs.ReadFile(s.static, "index.html")
		if err != nil {
			http.Error(w, "frontend not built – run `make web` (see README)", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})
}
