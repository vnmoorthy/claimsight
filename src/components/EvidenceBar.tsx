import { useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import type { DemoEvidence, EvidenceStage, EvidenceState } from '../types';
import { useT, type MessageKeys } from '../i18n';
import { EVIDENCE_STAGES } from '../lib/useEvidence';
import { IconAlert, IconCheck, IconChevronDown, IconClose, IconPaperclip, IconSpinner, IconVideo } from './icons';
import styles from './EvidenceBar.module.css';

const ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';

interface Props {
  orderId: string;
  onOrderIdChange: (value: string) => void;
  orderHint: string | null;
  orderMissing: boolean;
  evidence: EvidenceState;
  demoItems: DemoEvidence[];
  onAttachFile: (file: File) => void;
  onUseDemo: (item: DemoEvidence) => void;
  onClearEvidence: () => void;
  disabled: boolean;
}

/**
 * Claim context strip inside the composer: Order · Attach evidence · Demo clip,
 * plus the indexing / ready pill. Presentational — useEvidence owns the state.
 */
export default function EvidenceBar({
  orderId, onOrderIdChange, orderHint, orderMissing, evidence, demoItems, onAttachFile, onUseDemo, onClearEvidence, disabled,
}: Props) {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const busy = evidence.status === 'uploading' || evidence.status === 'indexing';

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again
    if (!file) return;
    const ok = /^video\/(mp4|quicktime)$/i.test(file.type) || /\.(mp4|mov)$/i.test(file.name);
    if (!ok) {
      setFileError(t('evidence.unsupported'));
      return;
    }
    setFileError(null);
    onAttachFile(file);
  };

  // Options are addressed by index: two demo clips may share a video_id (same
  // footage filed against different orders — the fraud-twin scenario).
  const handleDemoChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const item = demoItems[Number(e.target.value)];
    if (item) {
      setFileError(null);
      onUseDemo(item);
    }
  };

  const handleClear = () => {
    setFileError(null);
    onClearEvidence();
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <div className={styles.orderGroup}>
          <label className={`${styles.orderField} ${orderMissing ? styles.orderFieldMissing : ''}`}>
            <span className={styles.orderLabel}>{t('evidence.order')}</span>
            <input
              className={`${styles.orderInput} mono`}
              value={orderId}
              onChange={e => onOrderIdChange(e.target.value.toUpperCase())}
              placeholder={t('evidence.orderPlaceholder')}
              disabled={disabled}
              spellCheck={false}
              maxLength={16}
              aria-label={t('evidence.order')}
              data-testid="order-input"
            />
          </label>
          {orderHint && <span className={styles.orderHint} title={orderHint} data-testid="order-hint">{orderHint}</span>}
          {!orderHint && orderMissing && <span className={`${styles.orderHint} ${styles.orderHintMissing}`} data-testid="order-hint">{t('evidence.orderUnknown')}</span>}
        </div>

        <div className={styles.evidenceGroup}>
          <button
            type="button"
            className={`btn btn-sm ${styles.ctl}`}
            onClick={() => fileRef.current?.click()}
            disabled={disabled || busy}
            title={t('evidence.attach')}
          >
            <IconPaperclip size={14} />
            {t('evidence.attach')}
          </button>
          <input ref={fileRef} type="file" accept={ACCEPT} className={styles.fileInput} onChange={handleFileChange} tabIndex={-1} aria-hidden="true" />

          <span className={`${styles.selectWrap} ${disabled || busy || demoItems.length === 0 ? styles.selectDisabled : ''}`}>
            <IconVideo size={14} className={styles.selectIcon} />
            <select
              className={styles.demoSelect}
              value=""
              onChange={handleDemoChange}
              disabled={disabled || busy || demoItems.length === 0}
              aria-label={t('evidence.demo')}
              title={t('evidence.demo')}
            >
              <option value="" disabled>{t('evidence.demo')}</option>
              {demoItems.map((d, i) => (
                <option key={`${d.video_id}-${d.order_id}-${i}`} value={i}>{d.label}</option>
              ))}
            </select>
            <IconChevronDown size={13} className={styles.selectChevron} />
          </span>
        </div>
      </div>

      {(fileError || evidence.status !== 'idle') && (
        <EvidencePill evidence={evidence} fileError={fileError} onClear={handleClear} />
      )}
    </div>
  );
}

function Stages({ current }: { current?: EvidenceStage }) {
  const { t } = useT();
  const idx = current ? EVIDENCE_STAGES.indexOf(current) : 0;
  return (
    <span className={styles.stages}>
      {EVIDENCE_STAGES.map((stage, i) => (
        <span key={stage} className={`${styles.stage} ${i < idx ? styles.stageDone : ''} ${i === idx ? styles.stageActive : ''}`}>
          {i < idx ? <IconCheck size={11} strokeWidth={3} /> : i === idx ? <IconSpinner size={11} /> : <span className={styles.stageDot} />}
          {t(`evidence.stage.${stage}` as MessageKeys)}
          {i < EVIDENCE_STAGES.length - 1 && <span className={styles.stageArrow} aria-hidden="true">→</span>}
        </span>
      ))}
    </span>
  );
}

function EvidencePill({ evidence, fileError, onClear }: { evidence: EvidenceState; fileError: string | null; onClear: () => void }) {
  const { t } = useT();
  const clearBtn = (
    <button type="button" className={styles.removeBtn} onClick={onClear} aria-label={t('evidence.remove')} title={t('evidence.remove')}>
      <IconClose size={13} />
    </button>
  );

  if (fileError) {
    return (
      <div className={`${styles.pill} ${styles.pillError}`} role="alert">
        <IconAlert size={14} />
        <span className={styles.pillText}>{fileError}</span>
        {clearBtn}
      </div>
    );
  }

  switch (evidence.status) {
    case 'uploading':
      return (
        <div className={`${styles.pill} ${styles.pillBusy}`} role="status" aria-live="polite">
          <IconSpinner size={14} />
          <span className={styles.pillText}><b>{t('evidence.uploading')}</b> · {evidence.label}</span>
          {clearBtn}
        </div>
      );
    case 'indexing': {
      const progress = evidence.progress ?? 0;
      return (
        <div className={`${styles.pill} ${styles.pillBusy}`} role="status" aria-live="polite" style={{ '--p': `${progress}%` } as CSSProperties}>
          <IconSpinner size={14} />
          <span className={styles.pillText}>
            <b>{t('evidence.indexing')}</b>
            <Stages current={evidence.stage} />
            <span className={`${styles.percent} mono`}>{progress}%</span>
          </span>
          {clearBtn}
          <span className={styles.progress} aria-hidden="true" />
        </div>
      );
    }
    case 'ready':
      return (
        <div className={`${styles.pill} ${styles.pillReady}`} title={evidence.summary ?? evidence.videoId}>
          <IconVideo size={14} />
          <span className={styles.pillText}>
            <b>{t('evidence.ready')}</b> · {evidence.label}
            {evidence.source === 'demo' && <em className={styles.demoBadge}>{t('evidence.demoBadge')}</em>}
            <code className={`${styles.videoId} mono`} title={evidence.videoId}>{evidence.videoId}</code>
          </span>
          {clearBtn}
        </div>
      );
    case 'error':
      return (
        <div className={`${styles.pill} ${styles.pillError}`} role="alert">
          <IconAlert size={14} />
          <span className={styles.pillText}>{t('evidence.error')}: {evidence.error}</span>
          {clearBtn}
        </div>
      );
    default:
      return null;
  }
}
