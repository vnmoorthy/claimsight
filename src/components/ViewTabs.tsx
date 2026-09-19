import { useT, type MessageKeys } from '../i18n';
import styles from './ViewTabs.module.css';

export type ViewId = 'chat' | 'desk' | 'lab';

interface Props {
  view: ViewId;
  onChange: (view: ViewId) => void;
  /** Claims waiting for a human — shown as a badge on the Refund Desk tab. */
  pendingCount?: number;
}

const TABS: { id: ViewId; full: MessageKeys; short: MessageKeys }[] = [
  { id: 'chat', full: 'tabs.chat', short: 'tabs.chatShort' },
  { id: 'desk', full: 'tabs.desk', short: 'tabs.deskShort' },
  { id: 'lab', full: 'tabs.lab', short: 'tabs.labShort' },
];

/** Top-level "Chat | Refund Desk | Lab" switch. No router: the view is mirrored into `#desk` / `#lab`. */
export default function ViewTabs({ view, onChange, pendingCount = 0 }: Props) {
  const { t } = useT();
  const pendingLabel = t('tabs.pending').replace('{0}', String(pendingCount));
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('tabs.label')}>
      {TABS.map(tab => {
        const badge = tab.id === 'desk' && pendingCount > 0;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            className={`${styles.tab} ${view === tab.id ? styles.tabActive : ''}`}
            onClick={() => onChange(tab.id)}
            aria-label={badge ? `${t(tab.full)} · ${pendingLabel}` : t(tab.full)}
            data-testid={`tab-${tab.id}`}
          >
            <span className={styles.labelFull}>{t(tab.full)}</span>
            <span className={styles.labelShort} aria-hidden="true">{t(tab.short)}</span>
            {badge && <span className={styles.badge} aria-hidden="true">{pendingCount}</span>}
          </button>
        );
      })}
    </div>
  );
}
