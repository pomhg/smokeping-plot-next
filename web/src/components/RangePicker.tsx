import { useI18n } from '../i18n';

export const RANGES: { key: string; sec: number }[] = [
  { key: '1h', sec: 3600 },
  { key: '3h', sec: 3 * 3600 },
  { key: '12h', sec: 12 * 3600 },
  { key: '1d', sec: 86400 },
  { key: '3d', sec: 3 * 86400 },
  { key: '7d', sec: 7 * 86400 },
  { key: '30d', sec: 30 * 86400 },
  { key: '1y', sec: 365 * 86400 },
];

export function rangeLabel(key: string, lang: string): string {
  if (lang !== 'zh') return key;
  const n = key.slice(0, -1);
  const u = key.slice(-1);
  return `${n}${{ h: '小时', d: '天', y: '年' }[u] ?? u}`;
}

interface Props {
  value: string | null; // preset key, or null when zoomed to a custom window
  onChange: (key: string) => void;
  options?: { key: string; sec: number }[];
}

export function RangePicker({ value, onChange, options = RANGES }: Props) {
  const { lang } = useI18n();
  return (
    <div className="chips" role="tablist">
      {options.map((r) => (
        <button
          key={r.key}
          role="tab"
          aria-selected={value === r.key}
          className={`chip${value === r.key ? ' active' : ''}`}
          onClick={() => onChange(r.key)}
        >
          {rangeLabel(r.key, lang)}
        </button>
      ))}
    </div>
  );
}
