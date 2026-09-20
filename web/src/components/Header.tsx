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
  const themeLabel = pref === 'system' ? 'AUTO' : pref === 'light' ? 'LIGHT' : 'DARK';
  return (
    <header className="header">
      <Link to="/" className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" shapeRendering="crispEdges">
            <path d="M1 13h2v-4h2v2h2V5h2v6h2V8h2v3h2V7h2" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
        <span className="brand-name">smokeping-plot-next</span>
      </Link>
      <span className={`live${connected ? ' on' : ''}`} title={connected ? t('connected') : t('disconnected')}>
        <span className="live-led" />
        <span className="live-text">{connected ? t('connected') : t('disconnected')}</span>
      </span>
      <span className="spacer" />
      <button className="btn ghost" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title={t('language')} aria-label={t('language')}>
        {lang === 'zh' ? '中文' : 'EN'}
      </button>
      <button className="btn ghost" onClick={cycleTheme} title={`${t('theme')}: ${t(pref)}`} aria-label={t('theme')}>
        {themeLabel}
      </button>
      <button className="btn primary" onClick={onAdd}>
        <span className="plus">+</span>
        <span className="btn-label">{t('addTarget')}</span>
      </button>
    </header>
  );
}
