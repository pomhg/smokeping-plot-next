import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useTheme, type ThemePref } from '../theme';

interface Props {
  connected: boolean;
  onAdd: () => void;
}

export function Header({ connected, onAdd }: Props) {
  const { t, lang, setLang } = useI18n();
  const { pref, setPref } = useTheme();
  const cycleTheme = () => {
    const order: ThemePref[] = ['system', 'light', 'dark'];
    setPref(order[(order.indexOf(pref) + 1) % order.length]);
  };
  const themeIcon = pref === 'system' ? '◐' : pref === 'light' ? '☀' : '☾';
  return (
    <header className="header">
      <Link to="/" className="brand">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#1f2937" />
          <path d="M4 22 L9 14 L13 18 L18 8 L23 16 L28 12" fill="none" stroke="#94a3b8" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" opacity=".45" />
          <path d="M4 22 L9 14 L13 18 L18 8 L23 16 L28 12" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span className="brand-name">smokeping<span className="brand-accent">-plot-next</span></span>
      </Link>
      <span className={`live-pill${connected ? ' on' : ''}`} title={connected ? t('connected') : t('disconnected')}>
        <span className="live-dot" />
        <span className="live-text">{connected ? t('connected') : t('disconnected')}</span>
      </span>
      <span className="spacer" />
      <button className="icon-btn" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={t('language')} aria-label={t('language')}>
        {lang === 'zh' ? 'EN' : '中'}
      </button>
      <button className="icon-btn" onClick={cycleTheme} title={`${t('theme')}: ${t(pref)}`} aria-label={t('theme')}>
        {themeIcon}
      </button>
      <button className="btn primary" onClick={onAdd}>
        <span className="plus">+</span>
        <span className="btn-label">{t('addTarget')}</span>
      </button>
    </header>
  );
}
