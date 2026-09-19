import { useMemo, type MouseEvent } from 'react';
import type { ConversationSummary } from '../types';
import { useT } from '../i18n';
import Drawer from './Drawer';
import { IconPlus, IconTrash } from './icons';
import styles from './ConversationSidebar.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  conversations: ConversationSummary[];
  activeConversationId: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  disabled: boolean;       // Disabled while a stream is running
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLoadMore: () => void;
  onDelete: (id: string) => void;
}

function formatTimestamp(ts: number | undefined, lang: string): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return lang === 'zh' ? '刚刚' : 'Just now';
  if (diff < 60 * 60_000) {
    const m = Math.floor(diff / 60_000);
    return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`;
  }
  const today = new Date();
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
    return d.toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** "Claims history" — the conversation list as a slide-in drawer from the top bar. */
export default function ConversationSidebar({
  open, onClose, conversations, activeConversationId, loading, loadingMore, hasMore, disabled, onSelect, onCreate, onLoadMore, onDelete,
}: Props) {
  const { t, lang } = useT();

  const items = useMemo(
    () => conversations.map(c => ({ ...c, timeText: formatTimestamp(c.lastMessageAt ?? c.createdAt, lang) })),
    [conversations, lang],
  );

  const handleDeleteClick = (event: MouseEvent<HTMLButtonElement>, id: string) => {
    event.stopPropagation();
    event.preventDefault();
    if (disabled) return;
    onDelete(id);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="left"
      width={340}
      scrim="dark"
      label={t('sidebar.label')}
      title={t('sidebar.title')}
      closeLabel={t('sidebar.close')}
      headerExtra={
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { onCreate(); onClose(); }} disabled={disabled}>
          <IconPlus size={13} strokeWidth={2.6} />
          {t('sidebar.newChat')}
        </button>
      }
    >
      <div className={styles.listShell}>
        {items.length === 0 ? (
          loading ? null : (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{t('sidebar.emptyTitle')}</p>
              <p className={styles.emptyHint}>{t('sidebar.emptyHint')}</p>
            </div>
          )
        ) : (
          <ul className={styles.list}>
            {items.map(c => {
              const isActive = c.id === activeConversationId;
              return (
                <li key={c.id} className={`${styles.row} ${isActive ? styles.rowActive : ''}`}>
                  <button
                    type="button"
                    className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                    onClick={() => { if (!disabled && !isActive) { onSelect(c.id); onClose(); } }}
                    disabled={disabled && !isActive}
                    aria-current={isActive ? 'true' : 'false'}
                  >
                    <span className={styles.itemRow}>
                      <span className={styles.itemTitle}>{c.title}</span>
                      {c.timeText && <span className={`${styles.itemTime} mono`}>{c.timeText}</span>}
                    </span>
                    {c.preview && <span className={styles.itemPreview}>{c.preview}</span>}
                  </button>
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    onClick={e => handleDeleteClick(e, c.id)}
                    disabled={disabled}
                    aria-label={t('sidebar.delete')}
                    title={t('sidebar.delete')}
                  >
                    <IconTrash size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {hasMore && items.length > 0 && (
          <div className={styles.foot}>
            <button type="button" className="btn btn-sm" onClick={onLoadMore} disabled={loadingMore || disabled}>
              {loadingMore ? t('sidebar.loadingMore') : t('sidebar.loadMore')}
            </button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
