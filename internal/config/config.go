// Package config loads runtime configuration from environment variables
// (and a few flags), with sensible defaults for a LAN monitoring box.
package config

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Listen  string
	DataDir string

	// Defaults applied to newly created targets.
	DefaultStep  int // seconds between rounds
	DefaultPings int // pings per round

	// Delay between individual pings inside one round.
	PingInterval time.Duration
	// Per-ping timeout (also used for TCP connect).
	PingTimeout time.Duration

	// "auto" | "true" | "false" – raw ICMP sockets vs. unprivileged UDP ICMP.
	ProbePrivileged string

	RawRetention    time.Duration
	RollupRetention time.Duration

	AuthUser string
	AuthPass string
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDur(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func Load() (*Config, error) {
	c := &Config{
		Listen:          envStr("LISTEN", ":8080"),
		DataDir:         envStr("DATA_DIR", "./data"),
		DefaultStep:     envInt("DEFAULT_STEP", 60),
		DefaultPings:    envInt("DEFAULT_PINGS", 20),
		PingInterval:    envDur("PING_INTERVAL", 500*time.Millisecond),
		PingTimeout:     envDur("PING_TIMEOUT", 2*time.Second),
		ProbePrivileged: envStr("PROBE_PRIVILEGED", "auto"),
		RawRetention:    time.Duration(envInt("RAW_RETENTION_DAYS", 30)) * 24 * time.Hour,
		RollupRetention: time.Duration(envInt("ROLLUP_RETENTION_DAYS", 730)) * 24 * time.Hour,
		AuthUser:        os.Getenv("AUTH_USER"),
		AuthPass:        os.Getenv("AUTH_PASS"),
	}

	flag.StringVar(&c.Listen, "listen", c.Listen, "address to listen on")
	flag.StringVar(&c.DataDir, "data", c.DataDir, "directory for the SQLite database")
	flag.Parse()

	if c.DefaultStep < 10 {
		return nil, fmt.Errorf("DEFAULT_STEP must be >= 10s")
	}
	if c.DefaultPings < 1 || c.DefaultPings > 100 {
		return nil, fmt.Errorf("DEFAULT_PINGS must be within 1..100")
	}
	if (c.AuthUser == "") != (c.AuthPass == "") {
		return nil, fmt.Errorf("AUTH_USER and AUTH_PASS must be set together")
	}
	return c, nil
}
