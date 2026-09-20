import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Probe, type ProbeResult, type Target, type TargetInput } from '../api';
import { useI18n } from '../i18n';
import { fmtMs } from '../format';
import { Modal } from './Modal';
import { GroupCombobox } from './GroupCombobox';

interface Props {
  target?: Target; // undefined → create
  groups: string[];
  defaultGroup?: string;
  onClose: () => void;
  onSaved?: (msg: string) => void;
}

export function TargetForm({ target, groups, defaultGroup, onClose, onSaved }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity });

  const [name, setName] = useState(target?.name ?? '');
  const [host, setHost] = useState(target?.host ?? '');
  const [group, setGroup] = useState(target?.group ?? defaultGroup ?? '');
  const [probe, setProbe] = useState<Probe>(target?.probe ?? 'icmp');
  const [port, setPort] = useState(target?.port || 443);
  const [step, setStep] = useState(target?.step ?? 0);
  const [pings, setPings] = useState(target?.pings ?? 0);
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ProbeResult | null>(null);

  useEffect(() => {
    if (cfg && !target) {
      setStep((s) => s || cfg.defaultStep);
      setPings((p) => p || cfg.defaultPings);
    }
  }, [cfg, target]);

  const hosts = useMemo(
    () =>
      host
        .split(/[\n,;]+/)
        .map((h) => h.trim())
        .filter(Boolean),
    [host],
  );
  const bulk = !target && hosts.length > 1;

  const build = (h: string, n: string): TargetInput => ({
    name: n,
    host: h,
    group: group.trim(),
    probe,
    port: probe === 'tcp' ? port : 0,
    step,
    pings,
    enabled,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (target) {
        await api.updateTarget(target.id, build(hosts[0] ?? host, name));
        return t('saved');
      }
      if (bulk) {
        for (const h of hosts) await api.createTarget(build(h, h));
        return t('bulkCreated', { n: hosts.length });
      }
      const created = await api.createTarget(build(hosts[0] ?? host, name));
      return t('createdOne', { name: created.name });
    },
    onSuccess: (msg) => {
      qc.invalidateQueries({ queryKey: ['targets'] });
      onSaved?.(msg);
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const test = useMutation({
    mutationFn: () => api.probe(hosts[0] ?? host, probe, probe === 'tcp' ? port : 0, 5),
    onMutate: () => {
      setTestResult(null);
      setError(null);
    },
    onSuccess: setTestResult,
    onError: (e: Error) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate();
  };

  return (
    <Modal
      title={target ? t('editTarget') : t('addTarget')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={() => test.mutate()} disabled={!hosts.length || test.isPending}>
            {test.isPending ? t('testing') : t('test')}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="submit" form="target-form" className="btn primary" disabled={!hosts.length || save.isPending}>
            {target ? t('save') : bulk ? `${t('create')} (${hosts.length})` : t('create')}
          </button>
        </>
      }
    >
      <form id="target-form" onSubmit={submit} className="form">
        <label className="field">
          <span>{t('host')}</span>
          {target ? (
            <input value={host} onChange={(e) => setHost(e.target.value)} required autoFocus spellCheck={false} />
          ) : (
            <textarea
              value={host}
              onChange={(e) => setHost(e.target.value)}
              rows={host.includes('\n') ? 4 : 1}
              required
              autoFocus
              spellCheck={false}
              placeholder="192.168.1.1"
            />
          )}
          <small>{t('hostHint')}</small>
        </label>
        {!bulk && (
          <label className="field">
            <span>{t('name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={hosts[0] ?? ''} />
          </label>
        )}
        <label className="field">
          <span>{t('group')}</span>
          <GroupCombobox value={group} onChange={setGroup} options={groups} placeholder="LAN" />
          <small>{t('groupHint')}</small>
        </label>
        <div className="field-row">
          <label className="field">
            <span>{t('probe')}</span>
            <select value={probe} onChange={(e) => setProbe(e.target.value as Probe)}>
              <option value="icmp">{t('icmp')}</option>
              <option value="tcp">{t('tcp')}</option>
            </select>
          </label>
          {probe === 'tcp' && (
            <label className="field">
              <span>{t('port')}</span>
              <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(+e.target.value)} required />
            </label>
          )}
        </div>
        <div className="field-row">
          <label className="field">
            <span>{t('step')}</span>
            <input type="number" min={10} max={86400} value={step} onChange={(e) => setStep(+e.target.value)} required />
          </label>
          <label className="field">
            <span>{t('pings')}</span>
            <input type="number" min={1} max={100} value={pings} onChange={(e) => setPings(+e.target.value)} required />
          </label>
        </div>
        <label className="field check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('enabled')}</span>
        </label>
        {testResult && (
          <div className={`test-result ${testResult.sample.recv > 0 ? 'ok' : 'fail'}`}>
            {testResult.sample.recv > 0
              ? t('resultOk', { recv: testResult.sample.recv, sent: testResult.sample.sent, median: fmtMs(testResult.sample.median) })
              : t('resultFail', { sent: testResult.sample.sent })}
            {testResult.resolved && testResult.resolved !== hosts[0] && <span className="muted"> · {testResult.resolved}</span>}
            {testResult.sample.err && <div className="muted">{testResult.sample.err}</div>}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </form>
    </Modal>
  );
}
