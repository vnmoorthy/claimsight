import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClaimRecord, Decision, FraudMatch } from '../types';
import { useT } from '../i18n';
import { canonicalAction } from '../lib/decision';
import { fmtLatency, fmtMoney } from '../lib/format';
import { customerNameOf, displayIdOf, matchIdOf, modeLabelOf, prefersReducedMotion } from '../lib/labels';
import { useNav } from '../lib/nav';
import { clauseText } from '../lib/policyClauses';
import { mergeTwin, normalizeTwin } from '../lib/twin';
import ActionBadge from './ActionBadge';
import DamageTwinBlock from './DamageTwin';
import { IconAlert, IconArrowRight, IconCheck, IconHelp, IconSearch, LogoMark } from './icons';
import styles from './DecisionCard.module.css';

interface Props {
  decision: Decision;
  /** Stored claim record (when resolved) — adds fraud similarity, reason and who decided. */
  record?: ClaimRecord | null;
  /** True when the card just completed in a live stream — it scrolls itself into view. */
  live?: boolean;
  /** Mode label from GET /stats, used when neither the block nor the record carries one. */
  fallbackModeLabel?: string;
}

function matchesOf(record: ClaimRecord | null | undefined): FraudMatch[] {
  return Array.isArray(record?.fraud?.matches) ? record!.fraud!.matches! : [];
}

/**
 * The Decision Card — the receipt at the end of every claim. Rendered under the
 * assistant's prose once the fenced ```decision block has fully arrived.
 */
export default function DecisionCard({ decision, record, live = false, fallbackModeLabel }: Props) {
  const { t } = useT();
  const { openInDesk } = useNav();
  const rootRef = useRef<HTMLDivElement>(null);
  const action = canonicalAction(decision.action);
  const currency = decision.currency ?? record?.decision?.currency ?? 'USD';

  const fraudCount = decision.fraud_matches ?? matchesOf(record).length;
  const fraudBad = fraudCount > 0;
  const matches = matchesOf(record);
  const fraudLabel =
    fraudCount === 0 ? t('decision.fraudNone') :
    fraudCount === 1 ? t('decision.fraudOne') :
    t('decision.fraudMany').replace('{0}', String(fraudCount));

  const amount = decision.amount;
  const showAmount = amount !== undefined && amount > 0 && action !== 'denied' && action !== 'needs_info';
  const amountNote = action === 'escalated' ? t('decision.atStake') : undefined;
  const recommended = record?.decision?.recommended_action;
  const decidedBy = record?.decision?.by;
  const reason = decision.reason ?? record?.decision?.reason;
  const claimId = decision.claim_id ?? record?.claim_id;
  const displayId = displayIdOf({ display_id: decision.display_id ?? record?.display_id, claim_id: claimId, order_id: decision.order_id ?? record?.order_id });
  const customerName = customerNameOf({ customer_name: decision.customer_name ?? record?.customer_name, customer_id: record?.customer_id });
  const modeLabel = modeLabelOf(t, decision.mode_label ?? record?.mode_label ?? fallbackModeLabel, record?.model);
  const canOpenDesk = Boolean(claimId) && (action === 'escalated' || action === 'needs_info');

  // The twin as the block announced it, upgraded by whatever the stored record says
  // (a card restored from history reads `ready` straight from the record).
  const decisionTwin = decision.twin;
  const recordTwin = record?.twin;
  const twin = useMemo(() => mergeTwin(normalizeTwin(decisionTwin), normalizeTwin(recordTwin)), [decisionTwin, recordTwin]);

  // A card that just landed in a live stream scrolls itself into view.
  useEffect(() => {
    if (!live) return;
    const el = rootRef.current;
    if (!el) return;
    const id = window.requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [live]);

  return (
    <div
      ref={rootRef}
      className={`${styles.card} ${action ? styles[action] : styles.unknown}`}
      role="group"
      aria-label={`${t('decision.kicker')}: ${action ? t(`decision.action.${action}`) : decision.action}${displayId ? ` · ${displayId}` : ''}`}
      data-testid="decision-card"
      data-action={action ?? decision.action}
    >
      <div className={styles.head}>
        <span className={styles.brand}>
          <LogoMark size={14} />
          <span>{t('app.name')} · {t('decision.kicker')}</span>
        </span>
        {displayId && (
          <span className={`${styles.claimId} mono`} title={claimId && claimId !== displayId ? claimId : undefined} data-testid="decision-display-id">
            {displayId}
          </span>
        )}
      </div>

      <div className={styles.hero}>
        <div className={styles.badgeWrap}>
          <ActionBadge action={action} label={action ? undefined : decision.action} size="lg" />
          {action === 'escalated' && recommended && (
            <span className={styles.recommended}>{t('decision.recommended').replace('{0}', recommended)}</span>
          )}
          {action === 'needs_info' && !reason && (
            <span className={styles.recommended}>{t('decision.needsInfoHint')}</span>
          )}
        </div>
        {showAmount && (
          <div className={styles.amountWrap}>
            <span className={styles.amount}>{fmtMoney(amount, currency)}</span>
            {amountNote && <span className={styles.amountNote}>{amountNote}</span>}
          </div>
        )}
      </div>

      <dl className={styles.rows}>
        {customerName && (
          <div className={styles.row}>
            <dt className={styles.dt}>{t('decision.customer')}</dt>
            <dd className={styles.dd}>
              {customerName}
              {record?.customer_id && record.customer_id !== customerName && <span className={`${styles.subId} mono`}>{record.customer_id}</span>}
            </dd>
          </div>
        )}
        <div className={styles.row}>
          <dt className={styles.dt}>{t('decision.evidence')}</dt>
          <dd className={styles.dd}>{decision.evidence || record?.evidence_summary || '—'}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.dt}>{t('decision.policy')}</dt>
          <dd className={`${styles.dd} ${styles.chips}`}>
            {decision.policy_clauses.length === 0 && <span className={styles.muted}>—</span>}
            {decision.policy_clauses.map(clause => (
              <span key={clause} className={styles.chip} title={clauseText(clause)}>
                {clause.toUpperCase()}
              </span>
            ))}
          </dd>
        </div>
        {action !== 'needs_info' && (
          <div className={styles.row}>
            <dt className={styles.dt}>{t('decision.txn')}</dt>
            <dd className={`${styles.dd} mono ${decision.txn_id ? styles.txn : styles.muted}`} title={decision.txn_id ?? undefined}>
              {decision.txn_id ? (
                <>
                  <IconCheck size={13} strokeWidth={2.6} />
                  <span>{decision.txn_id}</span>
                </>
              ) : t('decision.txnNone')}
            </dd>
          </div>
        )}
        {reason && action !== 'refund' && action !== 'replacement' && (
          <div className={styles.row}>
            <dt className={styles.dt}>{t('decision.reason')}</dt>
            <dd className={styles.dd}>
              <ClampedText text={reason} moreLabel={t('decision.more')} lessLabel={t('decision.less')} />
            </dd>
          </div>
        )}
      </dl>

      <div className={`${styles.fraud} ${fraudBad ? styles.fraudBad : styles.fraudOk}`} role={fraudBad ? 'alert' : undefined} data-testid="fraud-panel">
        <span className={styles.fraudIcon}>{fraudBad ? <IconAlert size={15} /> : action === 'needs_info' ? <IconHelp size={15} /> : <IconSearch size={15} />}</span>
        <div className={styles.fraudBody}>
          <span className={styles.fraudTitle}>{fraudBad ? t('decision.fraudTitle') : t('decision.fraud')}</span>
          <span className={styles.fraudText}>{fraudLabel}</span>
          {fraudBad && matches.length > 0 && (
            <ul className={styles.matchList}>
              {matches.map((m, i) => (
                <li key={`${m.video_id ?? ''}-${i}`} data-testid="fraud-match">
                  <MatchLine match={m} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <DamageTwinBlock claimId={claimId} twin={twin} variant="card" />

      {canOpenDesk && (
        <div className={styles.actions}>
          <button type="button" className={`btn btn-sm ${styles.openDesk}`} onClick={() => openInDesk(claimId!)} data-testid="open-in-desk">
            {t('decision.openDesk')}
            <IconArrowRight size={13} />
          </button>
        </div>
      )}

      <div className={`${styles.foot} mono`}>
        {decision.latency_ms !== undefined && <span>{t('decision.latency')} {fmtLatency(decision.latency_ms)}</span>}
        {decidedBy && <span>{decidedBy === 'human' ? t('decision.by.human') : t('decision.by.agent')}</span>}
        {modeLabel && <span data-testid="decision-mode">{modeLabel}</span>}
      </div>
      <span className={styles.edge} aria-hidden="true" />
    </div>
  );
}

/** "Matches C-A1042-… filed by Alice Moreno · similarity 0.93" — one plain-English line per twin. */
export function MatchLine({ match: m }: { match: FraudMatch }) {
  const { t } = useT();
  const id = matchIdOf(m);
  const name = customerNameOf(m);
  const parts: ReactNode[] = [];
  if (id) {
    parts.push(
      <span key="id">
        {t('decision.matches')} <b className="mono" title={m.claim_id && m.claim_id !== id ? m.claim_id : undefined}>{id}</b>
      </span>,
    );
  }
  if (name) parts.push(<span key="name">{id ? ` ${t('decision.filedBy')} ` : `${t('decision.filedBy')} `}<b>{name}</b></span>);
  else if (m.order_id) parts.push(<span key="order">{id ? ' · ' : ''}{t('decision.matchedOrder')} <b className="mono">{m.order_id}</b></span>);
  if (typeof m.score === 'number') parts.push(<span key="score">{parts.length ? ' · ' : ''}{t('decision.similarity')} <b className="mono">{m.score.toFixed(2)}</b></span>);
  if (parts.length === 0 && m.video_id) parts.push(<span key="vid" className="mono">{m.video_id}</span>);
  return <>{parts}</>;
}

/** Two lines by default with a "more" toggle when the text overflows. */
export function ClampedText({ text, moreLabel, lessLabel, lines = 2 }: { text: string; moreLabel: string; lessLabel: string; lines?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (open) return;
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, open, lines]);

  return (
    <span className={styles.clampWrap}>
      <span
        ref={ref}
        className={open ? styles.clampOpen : styles.clamp}
        style={open ? undefined : { WebkitLineClamp: lines }}
        data-testid="reason-text"
      >
        {text}
      </span>
      {(overflows || open) && (
        <button type="button" className={styles.moreBtn} onClick={() => setOpen(v => !v)} aria-expanded={open}>
          {open ? lessLabel : moreLabel}
        </button>
      )}
    </span>
  );
}
