// Package store persists targets and probe samples in SQLite.
//
// Raw samples (one row per probe round) are kept for a limited window and
// consolidated into hourly rollups for long-range graphs, mirroring the
// multi-resolution archives smokeping keeps in RRD.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

type Target struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Host      string `json:"host"`
	Group     string `json:"group"`
	Probe     string `json:"probe"` // "icmp" | "tcp"
	Port      int    `json:"port"`
	Step      int    `json:"step"`  // seconds between rounds
	Pings     int    `json:"pings"` // probes per round
	Enabled   bool   `json:"enabled"`
	SortOrder int    `json:"sortOrder"`
	CreatedAt int64  `json:"createdAt"`
}

// Sample is the result of one probe round.
type Sample struct {
	TargetID int64     `json:"targetId"`
	TS       int64     `json:"ts"`
	Sent     int       `json:"sent"`
	Recv     int       `json:"recv"`
	Loss     float64   `json:"loss"` // percent 0..100
	Min      *float64  `json:"min"`
	P25      *float64  `json:"p25"`
	Median   *float64  `json:"median"`
	P75      *float64  `json:"p75"`
	Max      *float64  `json:"max"`
	Avg      *float64  `json:"avg"`
	RTTs     []float64 `json:"rtts,omitempty"`
	Err      string    `json:"err,omitempty"`
}

// Point is one aggregated bucket of a time series.
type Point struct {
	TS     int64    `json:"ts"`
	Sent   int      `json:"sent"`
	Recv   int      `json:"recv"`
	Loss   float64  `json:"loss"`
	Min    *float64 `json:"min"`
	P25    *float64 `json:"p25"`
	Median *float64 `json:"median"`
	P75    *float64 `json:"p75"`
	Max    *float64 `json:"max"`
	Avg    *float64 `json:"avg"`
}

type Store struct {
	db *sql.DB
}

func Open(dir string) (*Store, error) {
	path := filepath.Join(dir, "smokeping.db")
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// modernc/sqlite is happiest with a single writer; reads are cheap enough.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS targets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			host TEXT NOT NULL,
			grp TEXT NOT NULL DEFAULT '',
			probe TEXT NOT NULL DEFAULT 'icmp',
			port INTEGER NOT NULL DEFAULT 0,
			step INTEGER NOT NULL,
			pings INTEGER NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS samples (
			target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
			ts INTEGER NOT NULL,
			sent INTEGER NOT NULL,
			recv INTEGER NOT NULL,
			min REAL, p25 REAL, median REAL, p75 REAL, max REAL, avg REAL,
			rtts TEXT,
			err TEXT,
			PRIMARY KEY (target_id, ts)
		) WITHOUT ROWID`,
		`CREATE TABLE IF NOT EXISTS rollups (
			target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
			ts INTEGER NOT NULL,
			sent INTEGER NOT NULL,
			recv INTEGER NOT NULL,
			min REAL, p25 REAL, median REAL, p75 REAL, max REAL, avg REAL,
			PRIMARY KEY (target_id, ts)
		) WITHOUT ROWID`,
	}
	for _, q := range stmts {
		if _, err := s.db.Exec(q); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}

// ---------------------------------------------------------------- targets

const targetCols = `id, name, host, grp, probe, port, step, pings, enabled, sort_order, created_at`

func scanTarget(sc interface{ Scan(...any) error }) (Target, error) {
	var t Target
	var enabled int
	err := sc.Scan(&t.ID, &t.Name, &t.Host, &t.Group, &t.Probe, &t.Port, &t.Step, &t.Pings, &enabled, &t.SortOrder, &t.CreatedAt)
	t.Enabled = enabled != 0
	return t, err
}

func (s *Store) ListTargets(ctx context.Context) ([]Target, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+targetCols+` FROM targets ORDER BY grp, sort_order, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Target{}
	for rows.Next() {
		t, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) GetTarget(ctx context.Context, id int64) (Target, error) {
	t, err := scanTarget(s.db.QueryRowContext(ctx, `SELECT `+targetCols+` FROM targets WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

func (s *Store) CreateTarget(ctx context.Context, t Target) (Target, error) {
	t.CreatedAt = time.Now().Unix()
	// New targets go to the end of their group.
	if err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM targets WHERE grp = ?`, t.Group).Scan(&t.SortOrder); err != nil {
		return t, err
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO targets (name, host, grp, probe, port, step, pings, enabled, sort_order, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.Name, t.Host, t.Group, t.Probe, t.Port, t.Step, t.Pings, boolInt(t.Enabled), t.SortOrder, t.CreatedAt)
	if err != nil {
		return t, err
	}
	t.ID, _ = res.LastInsertId()
	return t, nil
}

func (s *Store) UpdateTarget(ctx context.Context, t Target) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE targets SET name=?, host=?, grp=?, probe=?, port=?, step=?, pings=?, enabled=?, sort_order=? WHERE id=?`,
		t.Name, t.Host, t.Group, t.Probe, t.Port, t.Step, t.Pings, boolInt(t.Enabled), t.SortOrder, t.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// OrderItem places a target into a group at a position.
type OrderItem struct {
	ID        int64  `json:"id"`
	Group     string `json:"group"`
	SortOrder int    `json:"sortOrder"`
}

// Reorder applies group/sort_order for the given targets atomically.
func (s *Store) Reorder(ctx context.Context, items []OrderItem) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, it := range items {
		if _, err := tx.ExecContext(ctx, `UPDATE targets SET grp = ?, sort_order = ? WHERE id = ?`, it.Group, it.SortOrder, it.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) DeleteTarget(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM targets WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------- samples

// NewSample computes the summary statistics for one probe round.
func NewSample(targetID, ts int64, sent int, rtts []float64, probeErr string) Sample {
	sm := Sample{TargetID: targetID, TS: ts, Sent: sent, Recv: len(rtts), Err: probeErr}
	if sent > 0 {
		sm.Loss = 100 * float64(sent-len(rtts)) / float64(sent)
		if sm.Loss < 0 {
			sm.Loss = 0
		}
	}
	if len(rtts) == 0 {
		return sm
	}
	sorted := append([]float64(nil), rtts...)
	sort.Float64s(sorted)
	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	f := func(v float64) *float64 { return &v }
	sm.Min = f(sorted[0])
	sm.Max = f(sorted[len(sorted)-1])
	sm.Avg = f(sum / float64(len(sorted)))
	sm.P25 = f(percentile(sorted, 0.25))
	sm.Median = f(percentile(sorted, 0.5))
	sm.P75 = f(percentile(sorted, 0.75))
	sm.RTTs = sorted
	return sm
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	pos := p * float64(len(sorted)-1)
	lo := int(pos)
	hi := lo + 1
	if hi >= len(sorted) {
		return sorted[lo]
	}
	frac := pos - float64(lo)
	return sorted[lo]*(1-frac) + sorted[hi]*frac
}

func (s *Store) InsertSample(ctx context.Context, sm Sample) error {
	var rtts any
	if len(sm.RTTs) > 0 {
		b, _ := json.Marshal(sm.RTTs)
		rtts = string(b)
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO samples (target_id, ts, sent, recv, min, p25, median, p75, max, avg, rtts, err)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sm.TargetID, sm.TS, sm.Sent, sm.Recv, sm.Min, sm.P25, sm.Median, sm.P75, sm.Max, sm.Avg, rtts, nullStr(sm.Err))
	return err
}

// LatestSamples returns the most recent sample for every target.
func (s *Store) LatestSamples(ctx context.Context) (map[int64]Sample, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT s.target_id, s.ts, s.sent, s.recv, s.min, s.p25, s.median, s.p75, s.max, s.avg, s.err
		FROM samples s
		JOIN (SELECT target_id, MAX(ts) AS ts FROM samples GROUP BY target_id) m
		  ON m.target_id = s.target_id AND m.ts = s.ts`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]Sample{}
	for rows.Next() {
		var sm Sample
		var errStr sql.NullString
		if err := rows.Scan(&sm.TargetID, &sm.TS, &sm.Sent, &sm.Recv, &sm.Min, &sm.P25, &sm.Median, &sm.P75, &sm.Max, &sm.Avg, &errStr); err != nil {
			return nil, err
		}
		sm.Err = errStr.String
		if sm.Sent > 0 {
			sm.Loss = 100 * float64(sm.Sent-sm.Recv) / float64(sm.Sent)
		}
		out[sm.TargetID] = sm
	}
	return out, rows.Err()
}

// Series returns the aggregated time series of a target between from and to
// (unix seconds), grouped into buckets of `bucket` seconds. When useRollups is
// set the hourly rollup table is consulted instead of raw samples.
func (s *Store) Series(ctx context.Context, targetID, from, to, bucket int64, useRollups bool) ([]Point, error) {
	table := "samples"
	if useRollups {
		table = "rollups"
	}
	q := fmt.Sprintf(`
		SELECT (ts / ?) * ? AS b,
		       SUM(sent), SUM(recv),
		       MIN(min),
		       SUM(p25 * recv) / NULLIF(SUM(recv), 0),
		       SUM(median * recv) / NULLIF(SUM(recv), 0),
		       SUM(p75 * recv) / NULLIF(SUM(recv), 0),
		       MAX(max),
		       SUM(avg * recv) / NULLIF(SUM(recv), 0)
		FROM %s
		WHERE target_id = ? AND ts >= ? AND ts < ?
		GROUP BY b ORDER BY b`, table)
	rows, err := s.db.QueryContext(ctx, q, bucket, bucket, targetID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Point{}
	for rows.Next() {
		var p Point
		if err := rows.Scan(&p.TS, &p.Sent, &p.Recv, &p.Min, &p.P25, &p.Median, &p.P75, &p.Max, &p.Avg); err != nil {
			return nil, err
		}
		if p.Sent > 0 {
			p.Loss = 100 * float64(p.Sent-p.Recv) / float64(p.Sent)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Rollup consolidates raw samples with ts >= since into hourly rollups.
func (s *Store) Rollup(ctx context.Context, since int64) error {
	since = since / 3600 * 3600
	_, err := s.db.ExecContext(ctx, `
		INSERT OR REPLACE INTO rollups (target_id, ts, sent, recv, min, p25, median, p75, max, avg)
		SELECT target_id, (ts / 3600) * 3600,
		       SUM(sent), SUM(recv),
		       MIN(min),
		       SUM(p25 * recv) / NULLIF(SUM(recv), 0),
		       SUM(median * recv) / NULLIF(SUM(recv), 0),
		       SUM(p75 * recv) / NULLIF(SUM(recv), 0),
		       MAX(max),
		       SUM(avg * recv) / NULLIF(SUM(recv), 0)
		FROM samples WHERE ts >= ?
		GROUP BY target_id, (ts / 3600)`, since)
	return err
}

// Prune deletes raw samples older than rawBefore and rollups older than rollupBefore.
func (s *Store) Prune(ctx context.Context, rawBefore, rollupBefore int64) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM samples WHERE ts < ?`, rawBefore); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM rollups WHERE ts < ?`, rollupBefore)
	return err
}

// Stats returns a few counters for the settings/about page.
func (s *Store) Stats(ctx context.Context) (map[string]int64, error) {
	out := map[string]int64{}
	for _, t := range []string{"targets", "samples", "rollups"} {
		var n int64
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+t).Scan(&n); err != nil {
			return nil, err
		}
		out[t] = n
	}
	return out, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
