import type { ClaimRecord, Decision, FraudMatch } from '../types';
import { useT } from '../i18n';
import { canonicalAction } from '../lib/decision';
import { fmtLatency, fmtMoney, shortId } from '../lib/format';
import { clauseText } from '../lib/policyClauses';
import ActionBadge from './ActionBadge';
import { IconAlert, IconCheck, IconSearch, LogoMark } from './icons';
import styles from './DecisionCard.module.css';

interface Props {
  decision: Decision;
  /** Stored claim record (when resolved) — adds fraud similarity, reason and who decided. */
  record?: ClaimRecord | null;
}

function matchesOf(record: ClaimRecord | null | undefined): FraudMatch[] {
  return Array.isArray(record?.fraud?.matches) ? record!.fraud!.matches! : [];
}

/**
 * The Decision Card — the receipt at the end of every claim. Rendered under the
 * assistant's prose once the fenced ```decision block has fully arrived.
 */
export default function DecisionCard({ decision, record }: Props) {
  const { t } = useT();
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
  const showAmount = amount !== undefined && amount > 0 && action !== 'denied';
  const amountNote = action === 'escalated' ? t('decision.atStake') : undefined;
  const recommended = record?.decision?.recommended_action;
  const decidedBy = record?.decision?.by;
  const reason = decision.reason ?? record?.decision?.reason;

  return (
    <div
      className={`${styles.card} ${action ? styles[action] : styles.unknown}`}
      role="group"
      aria-label={`${t('decision.kicker')}: ${action ? t(`decision.action.${action}`) : decision.action}`}
    >
      <div className={styles.head}>
        <span className={styles.brand}>
          <LogoMark size={14} />
          <span>{t('app.name')} · {t('decision.kicker')}</span>
        </span>
        {decision.claim_id && (
          <span className={`${styles.claimId} mono`} title={decision.claim_id}>{decision.claim_id}</span>
        )}
      </div>

      <div className={styles.hero}>
        <div className={styles.badgeWrap}>
          <ActionBadge action={action} label={action ? undefined : decision.action} size="lg" />
          {action === 'escalated' && recommended && (
            <span className={styles.recommended}>{t('decision.recommended').replace('{0}', recommended)}</span>
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
        {reason && action !== 'refund' && action !== 'replacement' && (
          <div className={styles.row}>
            <dt className={styles.dt}>{t('decision.reason')}</dt>
            <dd className={styles.dd}>{reason}</dd>
          </div>
        )}
      </dl>

      <div className={`${styles.fraud} ${fraudBad ? styles.fraudBad : styles.fraudOk}`} role={fraudBad ? 'alert' : undefined}>
        <span className={styles.fraudIcon}>{fraudBad ? <IconAlert size={15} /> : <IconSearch size={15} />}</span>
        <div className={styles.fraudBody}>
          <span className={styles.fraudTitle}>{fraudBad ? t('decision.fraudTitle') : t('decision.fraud')}</span>
          <span className={styles.fraudText}>{fraudLabel}</span>
          {fraudBad && matches.length > 0 && (
            <ul className={styles.matchList}>
              {matches.map((m, i) => (
                <li key={`${m.video_id ?? ''}-${i}`} className="mono">
                  {typeof m.score === 'number' && <span><em>{t('decision.similarity')}</em> {m.score.toFixed(2)}</span>}
                  {m.claim_id && <span><em>{t('decision.matchedClaim')}</em> {shortId(m.claim_id, 12, 4)}</span>}
                  {m.customer_id && <span><em>{t('decision.matchedAccount')}</em> {m.customer_id}</span>}
                  {m.order_id && <span><em>{t('decision.matchedOrder')}</em> {m.order_id}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={`${styles.foot} mono`}>
        {decision.latency_ms !== undefined && <span>{t('decision.latency')} {fmtLatency(decision.latency_ms)}</span>}
        {decidedBy && <span>{decidedBy === 'human' ? t('decision.by.human') : t('decision.by.agent')}</span>}
        {record?.model && <span>{record.model}</span>}
      </div>
      <span className={styles.edge} aria-hidden="true" />
    </div>
  );
}
