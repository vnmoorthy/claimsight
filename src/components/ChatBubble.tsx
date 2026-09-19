import { useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message, ImageAttachment } from '../types';
import { useT } from '../i18n';
import { extractDecision } from '../lib/decision';
import { shortId } from '../lib/format';
import { useClaimRecord } from '../lib/useClaimRecord';
import DecisionCard from './DecisionCard';
import { IconAlert, IconPackage, IconVideo, LogoMark } from './icons';
import styles from './ChatBubble.module.css';

interface Props {
  message: Message;
}

/** Where the inline `WSA` link in the wsa_missing label points (template feature, kept). */
const WSA_DOC_URL = 'https://pages.edgeone.ai/document/sandbox-network-search-tool';

function renderWsaMissingLabel(template: string) {
  const parts = template.split('{0}');
  if (parts.length !== 2) return template;
  return (
    <>
      {parts[0]}
      <a className={styles.searchLabelLink} href={WSA_DOC_URL} target="_blank" rel="noreferrer noopener">WSA</a>
      {parts[1]}
    </>
  );
}

const TABLE_ROW_BOUNDARY = /\|\s+\|/g;
const TABLE_SEPARATOR_ROW = /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function normalizeCompactTableLine(line: string): string {
  if (!line.includes('| |')) return line;
  const pipeIndexes = [...line.matchAll(/\|/g)].map(m => m.index ?? -1).filter(i => i >= 0);
  for (const index of pipeIndexes) {
    const table = line.slice(index);
    const normalizedTable = table.replace(TABLE_ROW_BOUNDARY, '|\n|');
    const rows = normalizedTable.split('\n').map(r => r.trim()).filter(Boolean);
    if (rows.length >= 2 && TABLE_SEPARATOR_ROW.test(rows[1])) {
      const prefix = line.slice(0, index).trimEnd();
      return prefix ? `${prefix}\n${normalizedTable}` : normalizedTable;
    }
  }
  return line;
}

function normalizeMarkdown(content: string): string {
  let inCodeFence = false;
  return content
    .split('\n')
    .map(line => {
      if (/^\s*(```|~~~)/.test(line)) {
        inCodeFence = !inCodeFence;
        return line;
      }
      return inCodeFence ? line : normalizeCompactTableLine(line);
    })
    .join('\n');
}

function getImageSrc(img: ImageAttachment | string): string {
  if (typeof img === 'string') return `data:image/png;base64,${img}`;
  return img.url || '';
}

function getImageAlt(img: ImageAttachment | string, idx: number): string {
  if (typeof img === 'string') return `tool result ${idx + 1}`;
  return `screenshot ${img.id.slice(0, 8)}`;
}

export default function ChatBubble({ message }: Props) {
  const { t, lang } = useT();
  const isUser = message.role === 'user';
  const images = message.images || [];
  const activity = message.activity;
  const meta = isUser ? message.meta : undefined;

  // Pull the ```decision block out of the assistant's markdown. Only parsed once
  // the closing fence is present; while streaming an open fence is hidden so the
  // reader never watches raw JSON being typed.
  const extracted = useMemo(
    () => (isUser ? null : extractDecision(message.content, !!message.streaming)),
    [isUser, message.content, message.streaming],
  );
  const content = isUser ? message.content : normalizeMarkdown(extracted?.text ?? '');
  const decision = extracted?.decision ?? null;
  const { record } = useClaimRecord(decision?.claim_id, !!decision);

  if (!isUser && !message.content && images.length === 0 && !activity) return null;

  const time = new Date(message.timestamp).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`${styles.row} ${isUser ? styles.userRow : styles.botRow}`}>
      <div className={styles.identity}>
        {isUser ? (
          <span className={`${styles.avatar} ${styles.userAvatar}`} aria-hidden="true">C</span>
        ) : (
          <span className={`${styles.avatar} ${styles.botAvatar}`} aria-hidden="true"><LogoMark size={15} /></span>
        )}
        <span className={styles.name}>{isUser ? t('chat.customer') : t('chat.bot')}</span>
        <span className={`${styles.time} mono`}>{time}</span>
      </div>

      <div className={`${styles.bubble} ${isUser ? styles.userBubble : styles.botBubble} ${decision ? styles.hasCard : ''}`}>
        {!isUser && activity?.type === 'web_search' && (
          <div
            className={`${styles.activity} ${activity.status === 'error' ? styles.activityError : activity.status === 'done' ? styles.activityDone : ''}`}
            role="status"
            aria-live="polite"
          >
            {activity.status === 'error' ? <IconAlert size={13} /> : <span className={styles.activityDot} aria-hidden="true" />}
            <span>{
              activity.status === 'error' && activity.errorCode === 'wsa_missing'
                ? renderWsaMissingLabel(t('webSearch.error.wsaMissing'))
                : activity.label
            }</span>
            {activity.status === 'error' && activity.errorCode === 'wsa_missing' && (
              <a className={styles.activityCta} href={WSA_DOC_URL} target="_blank" rel="noreferrer noopener">{t('webSearch.error.wsaCta')} →</a>
            )}
          </div>
        )}

        {meta && (meta.orderId || meta.evidenceVideoId) && (
          <div className={styles.metaRow}>
            {meta.orderId && (
              <span className={styles.metaChip}>
                <IconPackage size={12} />
                <span>{t('chat.orderChip')}</span>
                <b className="mono">{meta.orderId}</b>
              </span>
            )}
            {meta.evidenceVideoId && (
              <span className={styles.metaChip} title={meta.evidenceVideoId}>
                <IconVideo size={12} />
                <span>{meta.evidenceLabel || t('chat.evidenceChip')}</span>
                <b className="mono">{shortId(meta.evidenceVideoId, 14, 4)}</b>
                {meta.evidenceSource === 'demo' && <i className={styles.metaTag}>{t('evidence.demoBadge')}</i>}
              </span>
            )}
          </div>
        )}

        {isUser
          ? <p className={styles.userText}>{content}</p>
          : content && (
              <div className={`${styles.markdown} ${message.streaming ? styles.markdownStreaming : ''}`}>
                <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
              </div>
            )
        }

        {!isUser && extracted?.pending && (
          <div className={styles.decisionPending} role="status" aria-live="polite">
            <span className={styles.decisionPendingDot} aria-hidden="true" />
            {t('decision.pending')}
          </div>
        )}

        {decision && <DecisionCard decision={decision} record={record} />}

        {images.length > 0 && (
          <div className={styles.imageList}>
            {images.map((img, idx) => {
              const src = getImageSrc(img);
              if (!src) return null;
              return <img key={typeof img === 'string' ? idx : img.id} className={styles.image} src={src} alt={getImageAlt(img, idx)} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
