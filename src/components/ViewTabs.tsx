import { useT } from '../i18n';
import styles from './ViewTabs.module.css';

export type ViewId = 'chat' | 'desk';

interface Props {
  view: ViewId;
  onChange: (view: ViewId) => void;
  /** Claims waiting for a human — shown as a badge on the Refund Desk tab. */
  pendingCount?: number;
}

/** Top-level "Chat | Refund Desk" switch. No router: the view is mirrored into `#desk`. */
export default function ViewTabs({ view, onChange, pendingCount = 0 }: Props) {
  const { t } = useT();
  const pendingLabel = t('tabs.pending').replace('{0}', String(pendingCount));
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('tabs.label')}>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'chat'}
        className={`${styles.tab} ${view === 'chat' ? styles.tabActive : ''}`}
        onClick={() => onChange('chat')}
        data-testid="tab-chat"
      >
        {t('tabs.chat')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'desk'}
        className={`${styles.tab} ${view === 'desk' ? styles.tabActive : ''}`}
        onClick={() => onChange('desk')}
        aria-label={pendingCount > 0 ? `${t('tabs.desk')} · ${pendingLabel}` : t('tabs.desk')}
        data-testid="tab-desk"
      >
        <span className={styles.labelFull}>{t('tabs.desk')}</span>
        <span className={styles.labelShort} aria-hidden="true">{t('tabs.deskShort')}</span>
        {pendingCount > 0 && (
          <span className={styles.badge} aria-hidden="true">{pendingCount}</span>
        )}
      </button>
    </div>
  );
}
