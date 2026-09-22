import { useEffect, useState } from 'react';
import type { TargetView } from './api';
import { lossColor } from './format';

/**
 * up       – latest round got replies, no loss
 * degraded – latest round lost some packets
 * down     – latest round got no reply at all
 * stale    – enabled, but no round has been recorded for a while
 * pending  – enabled, no data yet
 * paused   – disabled by the user
 */
export type Status = 'up' | 'degraded' | 'down' | 'stale' | 'pending' | 'paused';

export const PROBLEM_STATUSES: Status[] = ['down', 'degraded', 'stale'];

/** Rounds are stamped with their start time and take a few seconds to run;
 *  allow a few missed rounds before calling the data stale. */
export function staleAfter(t: TargetView): number {
  return 3 * t.step + 30;
}

export function statusOf(t: TargetView, now: number): Status {
  if (!t.enabled) return 'paused';
  if (!t.last) return 'pending';
  if (now - t.last.ts > staleAfter(t)) return 'stale';
  if (t.last.recv === 0) return 'down';
  if (t.last.loss > 0) return 'degraded';
  return 'up';
}

export function statusColor(t: TargetView, now: number, dark: boolean): string {
  switch (statusOf(t, now)) {
    case 'paused':
    case 'pending':
      return 'transparent';
    case 'stale':
      return dark ? '#8a8a8a' : '#7a7a7a';
    case 'down':
      return lossColor(100, dark);
    default:
      return lossColor(t.last!.loss, dark);
  }
}

/** Seconds since the last successful round, for a target that is down.
 *  null when unknown; -1 when it has never answered. */
export function downFor(t: TargetView, now: number): number | null {
  if (t.lastUp === undefined || t.lastUp === null) return null;
  if (t.lastUp === 0) return -1;
  return Math.max(0, now - t.lastUp);
}

export function countStatuses(targets: TargetView[], now: number): Record<Status, number> {
  const c: Record<Status, number> = { up: 0, degraded: 0, down: 0, stale: 0, pending: 0, paused: 0 };
  for (const t of targets) c[statusOf(t, now)]++;
  return c;
}

/** Wall clock in unix seconds, re-rendering every `everyMs`. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}
