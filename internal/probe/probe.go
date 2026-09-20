// Package probe implements the measurement side of smokeping: every round a
// target is probed N times and the individual round-trip times are returned.
package probe

import (
	"context"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"time"

	probing "github.com/prometheus-community/pro-bing"
	"golang.org/x/net/icmp"
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
// of "auto", "true", "false". Detection only checks that the socket can be
// opened – it deliberately does not rely on a reply from loopback, which
// firewalls may swallow even when probing real hosts works fine.
func DetectPrivileged(mode string) bool {
	switch strings.ToLower(mode) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	}
	for _, priv := range []bool{true, false} {
		if err := canOpenICMP(priv); err == nil {
			slog.Info("icmp socket mode selected", "privileged", priv)
			return priv
		} else {
			slog.Debug("icmp socket mode unavailable", "privileged", priv, "err", err)
		}
	}
	slog.Warn("no usable ICMP socket; ICMP probes will fail. " +
		"Run as root / with CAP_NET_RAW, or set net.ipv4.ping_group_range on Linux.")
	return true
}

func canOpenICMP(priv bool) error {
	network := "udp4"
	if priv {
		network = "ip4:icmp"
	}
	c, err := icmp.ListenPacket(network, "")
	if err != nil {
		return err
	}
	return c.Close()
}

func trimErr(err error) string {
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
