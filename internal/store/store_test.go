package store

import (
	"context"
	"testing"
)

func TestNewSampleStats(t *testing.T) {
	sm := NewSample(1, 100, 5, []float64{5, 1, 3, 2, 4}, "")
	if sm.Recv != 5 || sm.Loss != 0 {
		t.Fatalf("recv/loss = %d/%v", sm.Recv, sm.Loss)
	}
	if *sm.Min != 1 || *sm.Max != 5 || *sm.Median != 3 || *sm.P25 != 2 || *sm.P75 != 4 || *sm.Avg != 3 {
		t.Fatalf("unexpected stats: %+v", sm)
	}

	lossy := NewSample(1, 100, 4, []float64{10}, "")
	if lossy.Loss != 75 {
		t.Fatalf("loss = %v, want 75", lossy.Loss)
	}
	down := NewSample(1, 100, 4, nil, "timeout")
	if down.Loss != 100 || down.Median != nil {
		t.Fatalf("down sample: %+v", down)
	}
}

func TestCreateAssignsSortOrderAndReorder(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	var ids []int64
	for _, h := range []string{"a", "b", "c"} {
		tg, err := st.CreateTarget(ctx, Target{Name: h, Host: h, Group: "g", Probe: "icmp", Step: 60, Pings: 5, Enabled: true})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, tg.ID)
	}
	list, _ := st.ListTargets(ctx)
	if list[0].SortOrder != 0 || list[1].SortOrder != 1 || list[2].SortOrder != 2 {
		t.Fatalf("sort orders not sequential: %+v", list)
	}
	// move c to the front and b into another group
	err = st.Reorder(ctx, []OrderItem{{ID: ids[2], Group: "g", SortOrder: 0}, {ID: ids[0], Group: "g", SortOrder: 1}, {ID: ids[1], Group: "h", SortOrder: 0}})
	if err != nil {
		t.Fatal(err)
	}
	list, _ = st.ListTargets(ctx)
	got := []string{list[0].Name, list[1].Name, list[2].Name}
	if got[0] != "c" || got[1] != "a" || got[2] != "b" || list[2].Group != "h" {
		t.Fatalf("unexpected order after reorder: %+v", list)
	}
}

func TestGroupOrder(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	for _, g := range []string{"b", "a", "", "c"} {
		if _, err := st.CreateTarget(ctx, Target{Name: g, Host: "h", Group: g, Probe: "icmp", Step: 60, Pings: 5, Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	names := func() string {
		list, _ := st.ListTargets(ctx)
		out := ""
		for _, x := range list {
			out += "[" + x.Group + "]"
		}
		return out
	}
	if got := names(); got != "[a][b][c][]" {
		t.Fatalf("default order = %s", got)
	}
	if err := st.SetGroupOrder(ctx, []string{"c", "", "a"}); err != nil {
		t.Fatal(err)
	}
	// explicit order first, then unknown groups alphabetically
	if got := names(); got != "[c][][a][b]" {
		t.Fatalf("custom order = %s", got)
	}
}

func TestSeriesAndRollup(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	tg, err := st.CreateTarget(ctx, Target{Name: "x", Host: "127.0.0.1", Probe: "icmp", Step: 60, Pings: 5, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	// Two hours of one-minute samples; second hour is fully down.
	base := int64(1_000_000) / 3600 * 3600
	for i := int64(0); i < 120; i++ {
		var rtts []float64
		if i < 60 {
			rtts = []float64{10, 12, 14, 16, 18}
		}
		if err := st.InsertSample(ctx, NewSample(tg.ID, base+i*60, 5, rtts, "")); err != nil {
			t.Fatal(err)
		}
	}

	pts, err := st.Series(ctx, tg.ID, base, base+7200, 600, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(pts) != 12 {
		t.Fatalf("got %d buckets, want 12", len(pts))
	}
	if pts[0].Sent != 50 || pts[0].Recv != 50 || *pts[0].Median != 14 || *pts[0].Min != 10 || *pts[0].Max != 18 {
		t.Fatalf("first bucket: %+v", pts[0])
	}
	if pts[11].Loss != 100 || pts[11].Median != nil {
		t.Fatalf("down bucket: %+v", pts[11])
	}

	if err := st.Rollup(ctx, base); err != nil {
		t.Fatal(err)
	}
	rp, err := st.Series(ctx, tg.ID, base, base+7200, 3600, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(rp) != 2 || rp[0].Sent != 300 || *rp[0].Median != 14 || rp[1].Loss != 100 {
		t.Fatalf("rollup series: %+v", rp)
	}

	// Pruning raw data must keep the rollups.
	if err := st.Prune(ctx, base+7200, base); err != nil {
		t.Fatal(err)
	}
	raw, _ := st.Series(ctx, tg.ID, base, base+7200, 600, false)
	rp2, _ := st.Series(ctx, tg.ID, base, base+7200, 3600, true)
	if len(raw) != 0 || len(rp2) != 2 {
		t.Fatalf("after prune raw=%d rollups=%d", len(raw), len(rp2))
	}

	if err := st.DeleteTarget(ctx, tg.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetTarget(ctx, tg.ID); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	rp3, _ := st.Series(ctx, tg.ID, base, base+7200, 3600, true)
	if len(rp3) != 0 {
		t.Fatalf("cascade delete left %d rollups", len(rp3))
	}
}
