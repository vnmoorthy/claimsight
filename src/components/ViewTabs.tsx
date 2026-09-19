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
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('tabs.label')}>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'chat'}
        className={`${styles.tab} ${view === 'chat' ? styles.tabActive : ''}`}
        onClick={() => onChange('chat')}
      >
        {t('tabs.chat')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'desk'}
        className={`${styles.tab} ${view === 'desk' ? styles.tabActive : ''}`}
        onClick={() => onChange('desk')}
      >
        {t('tabs.desk')}
        {pendingCount > 0 && (
          <span className={styles.badge} aria-label={t('tabs.pending').replace('{0}', String(pendingCount))}>{pendingCount}</span>
        )}
      </button>
    </div>
  );
}
