import { useEffect, useRef } from 'react';
import type { RawSseEvent } from '../api';
import { useT } from '../i18n';
import styles from './DebugPanel.module.css';

interface Props {
  events: RawSseEvent[];
  onClear: () => void;
}

/** Raw SSE log — every frame the backend streamed for the current claim. */
export default function DebugPanel({ events, onClear }: Props) {
  const { t, lang } = useT();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{t('debug.title')}</span>
        <span className={`${styles.count} mono`}>{events.length} {t('debug.events')}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClear} disabled={events.length === 0}>{t('debug.clear')}</button>
      </div>

      <div className={styles.body} ref={scrollRef}>
        {events.length === 0 && (
          <div className={styles.empty}>
            <span>{t('debug.empty')}</span>
            <span className={styles.emptyHint}>{t('debug.emptyHint')}</span>
          </div>
        )}

        {events.map((evt, i) => (
          <div key={i} className={styles.event}>
            <div className={styles.eventHeader}>
              <span className={`${styles.eventType} ${styles[`type_${evt.eventType}`] || styles.type_unknown}`}>{evt.eventType}</span>
              <span className={`${styles.eventTime} mono`}>
                {new Date(evt.timestamp).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
            <pre className={styles.eventData}>
              {typeof evt.data === 'object' && evt.data !== null ? JSON.stringify(evt.data, null, 2) : evt.raw}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
