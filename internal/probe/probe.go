// Package probe implements the measurement side of smokeping: every round a
// target is probed N times and the individual round-trip times are returned.
package probe

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	probing "github.com/prometheus-community/pro-bing"
)

// Result of one probe round. RTTs holds only the successful replies, in ms.
type Result struct {
	Sent int
	RTTs []float64
	Err  string
}

type Options struct {
	Interval   time.Duration // delay between individual probes
	Timeout    time.Duration // per probe
	Privileged bool          // raw ICMP socket vs. unprivileged UDP ICMP
}

type Request struct {
	Probe string // "icmp" | "tcp"
	Host  string
	Port  int
	Count int
}

// Run dispatches a probe round based on req.Probe.
func Run(ctx context.Context, req Request, opt Options) Result {
	switch req.Probe {
	case "tcp":
		return tcpRound(ctx, req, opt)
	default:
		return icmpRound(ctx, req, opt)
	}
}

func icmpRound(ctx context.Context, req Request, opt Options) Result {
	p, err := probing.NewPinger(req.Host)
	if err != nil {
		return Result{Sent: req.Count, Err: trimErr(err)}
	}
	p.Count = req.Count
	p.Interval = opt.Interval
	p.Timeout = time.Duration(req.Count)*opt.Interval + opt.Timeout
	p.RecordRtts = true
	p.SetPrivileged(opt.Privileged)

	if err := p.RunWithContext(ctx); err != nil {
		return Result{Sent: req.Count, Err: trimErr(err)}
	}
	st := p.Statistics()
	rtts := make([]float64, 0, len(st.Rtts))
	for _, d := range st.Rtts {
		rtts = append(rtts, float64(d.Microseconds())/1000)
	}
	// A reply that arrives after the round is counted as sent-but-lost, so
	// never report more replies than requests.
	if len(rtts) > req.Count {
		rtts = rtts[:req.Count]
	}
	sent := st.PacketsSent
	if sent < req.Count {
		sent = req.Count
	}
	return Result{Sent: sent, RTTs: rtts}
}

func tcpRound(ctx context.Context, req Request, opt Options) Result {
	addr := net.JoinHostPort(req.Host, strconv.Itoa(req.Port))
	res := Result{Sent: req.Count}
	d := net.Dialer{Timeout: opt.Timeout}
	for i := 0; i < req.Count; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return res
			case <-time.After(opt.Interval):
			}
		}
		start := time.Now()
		conn, err := d.DialContext(ctx, "tcp", addr)
		if err != nil {
			if res.Err == "" {
				res.Err = trimErr(err)
			}
			continue
		}
		res.RTTs = append(res.RTTs, float64(time.Since(start).Microseconds())/1000)
		conn.Close()
	}
	if len(res.RTTs) > 0 {
		res.Err = ""
	}
	return res
}

// DetectPrivileged decides whether raw ICMP sockets are usable. mode is one
// of "auto", "true", "false".
func DetectPrivileged(mode string) bool {
	switch strings.ToLower(mode) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	}
	for _, priv := range []bool{true, false} {
		if selfTest(priv) == nil {
			slog.Info("icmp socket mode selected", "privileged", priv)
			return priv
		}
	}
	slog.Warn("no working ICMP socket mode found; ICMP probes will fail. " +
		"Run as root / with CAP_NET_RAW, or set net.ipv4.ping_group_range on Linux.")
	return true
}

func selfTest(priv bool) error {
	p, err := probing.NewPinger("127.0.0.1")
	if err != nil {
		return err
	}
	p.Count = 1
	p.Timeout = time.Second
	p.SetPrivileged(priv)
	if err := p.Run(); err != nil {
		return err
	}
	if p.Statistics().PacketsRecv == 0 {
		return fmt.Errorf("no reply from loopback")
	}
	return nil
}

func trimErr(err error) string {
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
