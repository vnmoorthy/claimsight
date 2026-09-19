import type { BackendStatusHandle } from '../lib/useBackendStatus';
import type { Theme } from '../lib/theme';
import type { TraceState } from '../lib/trace';
import { backendLabelOf } from '../lib/labels';
import { REPO_URL } from '../lib/links';
import { LangToggle, useT } from '../i18n';
import ViewTabs, { type ViewId } from './ViewTabs';
import { IconGitHub, IconHistory, IconMoon, IconReceipt, IconSun, LogoMark } from './icons';
import styles from './TopBar.module.css';

interface Props {
  view: ViewId;
  onChangeView: (view: ViewId) => void;
  pendingCount: number;
  status: BackendStatusHandle;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenHistory: () => void;
  historyOpen: boolean;
  /** Opens the Decision trace drawer — the button only shows while the side panel is hidden (≤1099px). */
  onOpenTrace: () => void;
  tracePhase: TraceState['phase'];
}

export default function TopBar({ view, onChangeView, pendingCount, status, theme, onToggleTheme, onOpenHistory, historyOpen, onOpenTrace, tracePhase }: Props) {
  const { t } = useT();

  // Product word for the data source; the technical detail (store backend,
  // Memories.ai stub) lives only in the tooltip.
  const source = status.online ? backendLabelOf(t, status) : null;
  const statusWord = status.checking ? t('status.checking') : status.online ? source!.label : t('status.offline');
  const detail = status.online
    ? [
        status.backend ? `${status.backend} ${t('status.store')}` : null,
        status.memoriesStubbed === undefined ? null : (status.memoriesStubbed ? t('status.stub') : t('status.stubLive')),
        status.modeLabel ?? null,
      ].filter(Boolean).join(' · ')
    : '';
  const statusTitle = `${t('status.dataSource')}: ${statusWord}${detail ? ` · ${detail}` : ''}`;
  const pillTone = status.checking ? styles.pillChecking : !status.online ? styles.pillOff : source?.tone === 'live' ? styles.pillLive : source?.tone === 'demo' ? styles.pillDemo : styles.pillNeutral;

  const traceBadge = tracePhase === 'running' ? styles.traceRunning : tracePhase === 'done' ? styles.traceDone : tracePhase === 'error' ? styles.traceError : '';

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true"><LogoMark size={22} /></span>
        <span className={styles.name}>{t('app.name')}</span>
        <span className={styles.tagline}>{t('app.tagline')}</span>
      </div>

      <div className={styles.center}>
        <ViewTabs view={view} onChange={onChangeView} pendingCount={pendingCount} />
      </div>

      <div className={styles.right}>
        <span className={`${styles.status} ${pillTone}`} title={statusTitle} role="status" aria-live="polite" aria-label={statusTitle} data-testid="status-pill">
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.statusWord}>{statusWord}</span>
        </span>

        {view === 'chat' && (
          <button
            type="button"
            className={`iconBtn ${styles.traceBtn} ${traceBadge}`}
            onClick={onOpenTrace}
            aria-label={t('trace.open')}
            title={t('trace.open')}
            data-testid="trace-open"
          >
            <IconReceipt size={17} />
            {tracePhase !== 'idle' && <span className={styles.traceDot} aria-hidden="true" />}
          </button>
        )}

        <button
          type="button"
          className={`iconBtn ${styles.historyBtn} ${historyOpen ? styles.historyBtnActive : ''}`}
          onClick={onOpenHistory}
          aria-label={t('nav.history')}
          title={t('nav.history')}
          aria-pressed={historyOpen}
        >
          <IconHistory size={17} />
          <span className={styles.historyText}>{t('nav.history')}</span>
        </button>

        <button
          type="button"
          className="iconBtn"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>

        <LangToggle />

        <a className={`iconBtn ${styles.ghLink}`} href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label={t('nav.github')} title={t('nav.github')}>
          <IconGitHub size={17} />
        </a>
      </div>
    </header>
  );
}
