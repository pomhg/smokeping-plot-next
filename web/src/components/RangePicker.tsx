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

interface Props {
  value: string | null; // preset key, or null when zoomed to a custom window
  onChange: (key: string) => void;
  options?: { key: string; sec: number }[];
  label?: string;
}

export function RangePicker({ value, onChange, options = RANGES, label }: Props) {
  const { t } = useI18n();
  return (
    <div className="seg" role="tablist" aria-label={label ?? t('range')}>
      {options.map((r) => (
        <button
          key={r.key}
          role="tab"
          aria-selected={value === r.key}
          className={`seg-btn${value === r.key ? ' active' : ''}`}
          onClick={() => onChange(r.key)}
        >
          {r.key}
        </button>
      ))}
    </div>
  );
}

/** "3h" → "近 3 小时" / "Last 3h" for stat labels. */
export function rangeLabel(key: string, lang: string): string {
  if (lang !== 'zh') return `Last ${key}`;
  const n = key.slice(0, -1);
  const unit = { h: '小时', d: '天', y: '年' }[key.slice(-1)] ?? key.slice(-1);
  return `近 ${n} ${unit}`;
}
