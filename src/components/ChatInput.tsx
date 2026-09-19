import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import type { DemoEvidence, EvidenceState, MessageMeta } from '../types';
import { useT, type MessageKeys } from '../i18n';
import { fetchDemoEvidence, lookupOrder } from '../api';
import { DEMO_EVIDENCE_FALLBACK } from '../demoEvidence';
import { useEvidence } from '../lib/useEvidence';
import { fmtMoney, fmtRelative } from '../lib/format';
import EvidenceBar from './EvidenceBar';
import { IconSend, IconSpinner, IconStop, IconTrash } from './icons';
import styles from './ChatInput.module.css';

interface Props {
  onSend: (text: string, meta: MessageMeta) => void;
  onStop: () => void;
  onClear: () => void;
  disabled: boolean;
  /** Mirrors the composer's evidence state to the Decision trace panel. */
  onEvidenceChange?: (evidence: EvidenceState) => void;
}

const ORDER_ID_STORAGE_KEY = 'claimsight_order_id';
export const DEFAULT_ORDER_ID = 'A1042';

/**
 * Stage scenarios: one click fills the message, switches the order and picks
 * the matching demo clip, so "File claim" is the only remaining step.
 */
const PRESETS: { id: string; labelKey: MessageKeys; textKey: MessageKeys; orderId: string }[] = [
  { id: 'mug', labelKey: 'preset.mug', textKey: 'preset.mug.text', orderId: 'A1042' },
  { id: 'twin', labelKey: 'preset.twin', textKey: 'preset.twin.text', orderId: 'A1043' },
  { id: 'headphones', labelKey: 'preset.headphones', textKey: 'preset.headphones.text', orderId: 'A1050' },
];

/** True while the viewport matches `query` (re-evaluates on resize). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

function loadOrderId(): string {
  try {
    return localStorage.getItem(ORDER_ID_STORAGE_KEY) || DEFAULT_ORDER_ID;
  } catch {
    return DEFAULT_ORDER_ID;
  }
}

export default function ChatInput({ onSend, onStop, onClear, disabled, onEvidenceChange }: Props) {
  const { t } = useT();
  const [value, setValue] = useState('');
  const [orderId, setOrderId] = useState<string>(loadOrderId);
  const [orderHint, setOrderHint] = useState<string | null>(null);
  const [orderMissing, setOrderMissing] = useState(false);
  const [demoItems, setDemoItems] = useState<DemoEvidence[]>(DEMO_EVIDENCE_FALLBACK);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { evidence, attachFile, useDemo, clear: clearEvidence } = useEvidence();
  const narrow = useMediaQuery('(max-width: 640px)');
  const placeholder = narrow ? t('composer.placeholderShort') : t('composer.placeholder');

  const evidenceBusy = evidence.status === 'uploading' || evidence.status === 'indexing';

  useEffect(() => { onEvidenceChange?.(evidence); }, [evidence, onEvidenceChange]);

  // Remember the order across reloads.
  useEffect(() => {
    try { localStorage.setItem(ORDER_ID_STORAGE_KEY, orderId); } catch { /* private mode */ }
  }, [orderId]);

  // Demo clips: prefer GET /demo-evidence, keep the static fallback otherwise.
  useEffect(() => {
    let cancelled = false;
    fetchDemoEvidence().then(list => {
      if (!cancelled && list.length > 0) setDemoItems(list);
    });
    return () => { cancelled = true; };
  }, []);

  // Live order hint next to the Order field (debounced; silent when the backend is down).
  useEffect(() => {
    const id = orderId.trim();
    if (!id) {
      setOrderHint(null);
      setOrderMissing(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const order = await lookupOrder(id);
      if (cancelled) return;
      if (!order) {
        setOrderHint(null);
        setOrderMissing(id.length >= 4);
        return;
      }
      setOrderMissing(false);
      const first = order.items?.[0];
      const parts = [
        first?.name,
        order.total !== undefined ? fmtMoney(order.total, order.currency ?? 'USD') : undefined,
        order.delivered_at ? `delivered ${fmtRelative(order.delivered_at)}` : undefined,
      ].filter(Boolean);
      setOrderHint(parts.length > 0 ? parts.join(' · ') : null);
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [orderId]);

  const resetTextareaHeight = () => {
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled || evidenceBusy) return;

    const meta: MessageMeta = { orderId: orderId.trim() || DEFAULT_ORDER_ID };
    if (evidence.status === 'ready' && evidence.videoId) {
      meta.evidenceVideoId = evidence.videoId;
      meta.evidenceLabel = evidence.label;
      meta.evidenceSummary = evidence.summary;
      meta.evidenceSource = evidence.source;
    }

    onSend(trimmed, meta);
    setValue('');
    setActivePreset(null);
    resetTextareaHeight();
    // The evidence rides along with exactly one message.
    if (evidence.status === 'ready') clearEvidence();
  }, [value, disabled, evidenceBusy, orderId, evidence, onSend, clearEvidence]);

  // Auto-send: the message was typed while the upload was still indexing — the
  // moment it flips to ready, file the claim with the video id.
  const prevStatusRef = useRef(evidence.status);
  useEffect(() => {
    const was = prevStatusRef.current;
    prevStatusRef.current = evidence.status;
    if (was === 'indexing' && evidence.status === 'ready' && value.trim() && !disabled) {
      handleSend();
    }
  }, [evidence.status, value, disabled, handleSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const handlePreset = (preset: typeof PRESETS[number]) => {
    if (disabled) return;
    setOrderId(preset.orderId);
    setValue(t(preset.textKey));
    setActivePreset(preset.id);
    const clip = demoItems.find(d => d.order_id?.toUpperCase() === preset.orderId);
    if (clip) useDemo(clip);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      handleInput();
    });
  };

  const handleAttachFile = (file: File) => {
    attachFile(file, orderId.trim() || DEFAULT_ORDER_ID);
  };

  const handleUseDemo = (item: DemoEvidence) => {
    useDemo(item);
    if (item.order_id) setOrderId(item.order_id.toUpperCase());
  };

  const sendBlocked = !value.trim() || disabled || evidenceBusy;
  const queued = evidenceBusy && value.trim().length > 0;

  return (
    <div className={styles.composer}>
      <div className={styles.presets} role="group" aria-label={t('composer.scenarios')}>
        <span className={`kicker ${styles.presetsLabel}`}>{t('composer.scenarios')}</span>
        {PRESETS.map(preset => (
          <button
            key={preset.id}
            type="button"
            className={`${styles.presetChip} ${activePreset === preset.id ? styles.presetActive : ''}`}
            onClick={() => handlePreset(preset)}
            disabled={disabled}
            title={t(preset.textKey)}
            data-testid={`preset-${preset.id}`}
          >
            <span className={`${styles.presetOrder} mono`}>{preset.orderId}</span>
            {t(preset.labelKey)}
          </button>
        ))}
      </div>

      <EvidenceBar
        orderId={orderId}
        onOrderIdChange={setOrderId}
        orderHint={orderHint}
        orderMissing={orderMissing}
        evidence={evidence}
        demoItems={demoItems}
        onAttachFile={handleAttachFile}
        onUseDemo={handleUseDemo}
        onClearEvidence={clearEvidence}
        disabled={disabled}
      />

      <div className={`${styles.inputWrap} ${disabled ? styles.inputDisabled : ''}`}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={placeholder}
          value={value}
          onChange={e => { setValue(e.target.value); setActivePreset(null); }}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          rows={1}
          disabled={disabled}
          aria-label={t('composer.placeholder')}
          data-testid="composer-input"
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={`iconBtn ${styles.clearBtn}`}
            onClick={onClear}
            disabled={disabled}
            aria-label={t('aria.clearHistory')}
            title={t('aria.clearHistory')}
            data-testid="clear-conversation"
          >
            <IconTrash size={15} />
          </button>
          {disabled ? (
            <button type="button" className={`btn btn-crit ${styles.stopBtn}`} onClick={onStop} aria-label={t('aria.stopGeneration')} title={t('aria.stopGeneration')}>
              <IconStop size={12} />
              {t('composer.stop')}
            </button>
          ) : (
            <button
              type="button"
              className={`btn btn-primary ${styles.sendBtn} ${queued ? styles.sendQueued : ''}`}
              onClick={handleSend}
              disabled={sendBlocked}
              aria-label={queued ? t('composer.waiting') : t('aria.send')}
              title={queued ? t('composer.waiting') : t('aria.send')}
              data-testid="file-claim"
            >
              {queued ? <IconSpinner size={14} /> : <IconSend size={14} />}
              {queued ? t('composer.waiting') : t('composer.file')}
            </button>
          )}
        </div>
      </div>
      <p className={`${styles.hint} ${queued ? styles.hintQueued : ''} ${disabled ? styles.hintChecking : ''}`} role={disabled ? 'status' : undefined} aria-live={disabled ? 'polite' : undefined} data-testid="composer-hint">
        {disabled ? (
          <>
            <span className={styles.checkingDot} aria-hidden="true" />
            {t('composer.checking')}
          </>
        ) : queued ? t('composer.hintQueued') : t('composer.hint')}
      </p>
    </div>
  );
}
