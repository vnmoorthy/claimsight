import type { BackendStatusHandle } from '../lib/useBackendStatus';
import type { Theme } from '../lib/theme';
import { LangToggle, useT } from '../i18n';
import ViewTabs, { type ViewId } from './ViewTabs';
import { IconGitHub, IconHistory, IconMoon, IconSun, LogoMark } from './icons';
import styles from './TopBar.module.css';

const REPO_URL = 'https://github.com/vnmoorthy/claimsight';

interface Props {
  view: ViewId;
  onChangeView: (view: ViewId) => void;
  pendingCount: number;
  status: BackendStatusHandle;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenHistory: () => void;
  historyOpen: boolean;
}

export default function TopBar({ view, onChangeView, pendingCount, status, theme, onToggleTheme, onOpenHistory, historyOpen }: Props) {
  const { t } = useT();

  const statusWord = status.checking ? t('status.checking') : status.online ? t('status.live') : t('status.offline');
  const detail = status.online
    ? [status.backend ? `${status.backend} ${t('status.store')}` : null, status.memoriesStubbed === undefined ? null : (status.memoriesStubbed ? t('status.stub') : t('status.stubLive'))].filter(Boolean).join(' · ')
    : '';
  const statusTitle = detail ? `${statusWord} · ${detail}` : statusWord;
  const dotClass = status.checking ? styles.dotChecking : status.online ? styles.dotLive : styles.dotOff;

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
        <span className={styles.status} title={statusTitle} role="status" aria-live="polite">
          <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
          <span className={styles.statusWord}>{statusWord}</span>
          {detail && <span className={styles.statusDetail}>{detail}</span>}
        </span>

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
        >
          {theme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>

        <LangToggle />

        <a className="iconBtn" href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label={t('nav.github')} title={t('nav.github')}>
          <IconGitHub size={17} />
        </a>
      </div>
    </header>
  );
}
