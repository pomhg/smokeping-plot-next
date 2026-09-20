export type Probe = 'icmp' | 'tcp';

export interface Target {
  id: number;
  name: string;
  host: string;
  group: string;
  probe: Probe;
  port: number;
  step: number;
  pings: number;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
}

export interface Sample {
  targetId: number;
  ts: number;
  sent: number;
  recv: number;
  loss: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  avg: number | null;
  rtts?: number[];
  err?: string;
}

export type Point = Omit<Sample, 'targetId' | 'rtts' | 'err'>;

export interface TargetView extends Target {
  last: Sample | null;
}

export interface Series {
  targetId: number;
  from: number;
  to: number;
  bucket: number;
  source: 'raw' | 'rollup';
  points: Point[];
}

export interface AppConfig {
  version: string;
  defaultStep: number;
  defaultPings: number;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  rawRetentionDays: number;
  rollupRetentionDays: number;
  icmpPrivileged: boolean;
  authEnabled: boolean;
}

export interface TargetInput {
  name: string;
  host: string;
  group: string;
  probe: Probe;
  port: number;
  step: number;
  pings: number;
  enabled: boolean;
}

export interface ProbeResult {
  sample: Sample;
  resolved: string;
  durationMs: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const api = {
  config: () => request<AppConfig>('/api/config'),
  stats: () => request<Record<string, number>>('/api/stats'),
  targets: () => request<{ targets: TargetView[] }>('/api/targets').then((r) => r.targets),
  createTarget: (t: TargetInput) => request<Target>('/api/targets', { method: 'POST', body: JSON.stringify(t) }),
  updateTarget: (id: number, t: TargetInput) =>
    request<Target>(`/api/targets/${id}`, { method: 'PUT', body: JSON.stringify(t) }),
  reorderTargets: (items: { id: number; group: string; sortOrder: number }[]) =>
    request<void>('/api/targets/order', { method: 'PUT', body: JSON.stringify({ items }) }),
  setGroupOrder: (groups: string[]) =>
    request<void>('/api/groups/order', { method: 'PUT', body: JSON.stringify({ groups }) }),
  deleteTarget: (id: number) => request<void>(`/api/targets/${id}`, { method: 'DELETE' }),
  series: (id: number, from: number, to: number, points: number) =>
    request<Series>(`/api/targets/${id}/series${qs({ from, to, points })}`),
  multiSeries: (from: number, to: number, points: number, ids?: number[]) =>
    request<{ series: Record<string, Series> }>(
      `/api/series${qs({ from, to, points, ids: ids?.join(',') })}`,
    ).then((r) => r.series),
  probe: (host: string, probe: Probe, port: number, count = 5) =>
    request<ProbeResult>('/api/probe', { method: 'POST', body: JSON.stringify({ host, probe, port, count }) }),
};
