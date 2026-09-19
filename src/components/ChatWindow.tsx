import { useEffect, useRef } from 'react';
import type { Message } from '../types';
import { useT } from '../i18n';
import ChatBubble from './ChatBubble';
import { LogoMark } from './icons';
import styles from './ChatWindow.module.css';

interface Props {
  messages: Message[];
  loading: boolean;
}

export default function ChatWindow({ messages, loading }: Props) {
  const { t } = useT();
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length === 0 && !loading) return;
    const el = windowRef.current;
    if (!el) return;
    // Scroll only this container (never ancestors); instant while streaming to avoid jitter.
    el.scrollTo({ top: el.scrollHeight, behavior: loading ? 'instant' : 'smooth' });
  }, [messages, loading]);

  // The typing row fills the gap before the first token; after that the in-bubble caret takes over.
  const lastMsg = messages[messages.length - 1];
  const showTyping = loading && !(lastMsg?.role === 'assistant' && (lastMsg.content.length > 0 || lastMsg.activity));

  return (
    <div ref={windowRef} className={styles.window}>
      <div className={styles.inner}>
        {messages.length === 0 && (
          <div className={styles.empty}>
            <span className={styles.emptyMark} aria-hidden="true"><LogoMark size={26} /></span>
            <h2 className={styles.emptyTitle}>{t('empty.title')}</h2>
            <p className={styles.emptyHint}>{t('empty.hint')}</p>
            <p className={`${styles.emptySteps} mono`}>{t('empty.steps')}</p>
            <p className={styles.emptyTip}>{t('empty.tip')}</p>
          </div>
        )}

        {messages.map(msg => (
          <ChatBubble key={msg.id} message={msg} />
        ))}

        {showTyping && (
          <div className={styles.typingRow} role="status" aria-live="polite">
            <span className={styles.typingAvatar} aria-hidden="true"><LogoMark size={15} /></span>
            <span className={styles.typingName}>{t('chat.bot')}</span>
            <span className={styles.typing}>
              <span /><span /><span />
            </span>
            <span className={styles.typingText}>{t('chat.thinking')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
