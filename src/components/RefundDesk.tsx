import { resetDemo } from '../api';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ClaimRecord, ClaimStatus, FraudMatch, StatsSnapshot } from '../types';
import { fetchClaims, fetchStats, submitClaimDecision } from '../api';
import { useT, type MessageKeys } from '../i18n';
import { canonicalAction } from '../lib/decision';
import { demoClipLabel } from '../demoEvidence';
import { fmtClock, fmtLatency, fmtMoney, fmtPercent, fmtRelative, median, toMillis } from '../lib/format';
import { customerNameOf, displayIdOf, evidenceFrameUrlOf, hasCustomerName, modeLabelOf } from '../lib/labels';
import type { DeskFocus } from '../lib/nav';
import { clauseText } from '../lib/policyClauses';
import { useToast } from '../lib/toast';
import { stepsFromToolCalls, stepElapsedMs } from '../lib/trace';
import { isTwinVisible, normalizeTwin } from '../lib/twin';
import ActionBadge from './ActionBadge';
import DamageTwinBlock from './DamageTwin';
import { MatchLine } from './DecisionCard';
import Drawer from './Drawer';
import EvidenceFrame from './EvidenceFrame';
import { IconAlert, IconArrowRight, IconBolt, IconCheck, IconClock, IconFilm, IconHelp, IconInbox, IconMinus, IconRefresh, IconSwap, IconX } from './icons';
import styles from './RefundDesk.module.css';

const REFRESH_MS = 5000;
const SKELETON_ROWS = 6;

type Filter = 'all' | 'pending_review' | 'needs_info' | 'auto_approved' | 'approved' | 'replacement' | 'denied';
const FILTERS: Filter[] = ['all', 'pending_review', 'needs_info', 'auto_approved', 'approved', 'replacement', 'denied'];
const KNOWN_STATUSES: readonly ClaimStatus[] = ['auto_approved', 'pending_review', 'approved', 'denied', 'replacement', 'needs_info'];

/** Collapse whatever spelling the backend used onto the SPEC's statuses. */
export function normalizeStatus(status: string | undefined | null): ClaimStatus | 'unknown' {
  const s = (status ?? '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if ((KNOWN_STATUSES as readonly string[]).includes(s)) return s as ClaimStatus;
  if (s === 'escalated' || s === 'pending' || s === 'review' || s === 'needs_review' || s === 'in_review') return 'pending_review';
  if (s === 'rejected' || s === 'deny' || s === 'declined') return 'denied';
  if (s === 'refunded' || s === 'auto_refund' || s === 'auto_refunded') return 'auto_approved';
  if (s === 'replaced') return 'replacement';
  if (s === 'need_info' || s === 'needs_information' || s === 'needs_more_info' || s === 'more_info' || s === 'info_needed' || s === 'info_requested' || s === 'unknown_order' || s === 'order_not_found') return 'needs_info';
  return 'unknown';
}

interface Props {
  /** Polling only runs while the desk is the visible view. */
  active: boolean;
  onPendingCount?: (count: number) => void;
  onGoToChat: () => void;
  /** `#desk?claim=<id>` — open this claim's drawer (nonce changes re-open it). */
  focus?: DeskFocus | null;
  /** The drawer for the focused claim was closed — the caller drops the claim from the hash. */
  onFocusDone?: () => void;
  /** Mode label from GET /stats, used when a record carries none. */
  modeLabel?: string;
}

function fraudMatches(c: ClaimRecord): FraudMatch[] {
  return Array.isArray(c.fraud?.matches) ? c.fraud.matches : [];
}
function fraudChecked(c: ClaimRecord): boolean {
  return c.fraud !== undefined && c.fraud !== null && c.fraud.checked !== false;
}
function isNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export default function RefundDesk({ active, onPendingCount, onGoToChat, focus, onFocusDone, modeLabel }: Props) {
  const { t } = useT();
  const toast = useToast();
  const [claims, setClaims] = useState<ClaimRecord[] | null>(null);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justDecided, setJustDecided] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const [c, s] = await Promise.allSettled([fetchClaims(), fetchStats()]);
      const statsValue = s.status === 'fulfilled' ? s.value : null;
      // GET /claims-list is the source of truth; fall back to the recent list in /stats.
      const list = c.status === 'fulfilled' ? c.value : (statsValue?.recent ?? null);
      if (c.status === 'rejected') console.warn('[desk] GET /claims-list failed:', (c.reason as Error)?.message ?? c.reason);
      if (s.status === 'rejected') console.warn('[desk] GET /stats failed:', (s.reason as Error)?.message ?? s.reason);
      if (list) setClaims(list);
      if (statsValue) setStats(statsValue);
      const reachable = Boolean(list || statsValue);
      setOffline(!reachable);
      if (reachable) setUpdatedAt(Date.now());
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [active, refresh]);

  const all = useMemo(() => claims ?? [], [claims]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: all.length };
    for (const c of all) {
      const s = normalizeStatus(c.status);
      m[s] = (m[s] ?? 0) + 1;
    }
    return m;
  }, [all]);

  const pendingCount = counts.pending_review ?? 0;
  useEffect(() => {
    if (claims !== null) onPendingCount?.(pendingCount);
  }, [claims, pendingCount, onPendingCount]);

  const visible = useMemo(
    () => all.filter(c => filter === 'all' || normalizeStatus(c.status) === filter),
    [all, filter],
  );

  const selected = useMemo(() => (selectedId ? all.find(c => c.claim_id === selectedId) ?? null : null), [all, selectedId]);

  // KPI strip: counters from /stats, computed from the claim list when absent.
  const counters = stats?.counters ?? {};
  const total = counters.claims ?? all.length;
  const autoApproved = counters.auto_approved ?? (counts.auto_approved ?? 0);
  const denied = counters.denied ?? (counts.denied ?? 0);
  const refunded = counters.refunded_total ?? all
    .filter(c => {
      const s = normalizeStatus(c.status);
      return (s === 'auto_approved' || s === 'approved') && canonicalAction(c.decision?.action) !== 'denied';
    })
    .reduce((sum, c) => sum + (isNumber(c.decision?.amount) ? c.decision.amount : 0), 0);
  const fraudFlags = counters.fraud_flags ?? all.filter(c => fraudMatches(c).length > 0).length;
  const medianLatency = stats?.medianLatencyMs ?? median(all.map(c => c.latency_ms).filter(isNumber));
  const autoRate = total > 0 ? autoApproved / total : undefined;

  const openClaim = useCallback((id: string) => {
    setSelectedId(id);
    setNote('');
    setSubmitError(null);
    setJustDecided(null);
  }, []);

  const closeClaim = useCallback(() => {
    setSelectedId(null);
    if (focus) onFocusDone?.();
  }, [focus, onFocusDone]);

  // The drawer polls GET /claim while its Damage Twin renders; fold what it
  // brings back into the list so the row's film-strip icon lights up too.
  const handleTwinRecord = useCallback((record: ClaimRecord) => {
    setClaims(prev => (prev ? prev.map(c => (c.claim_id === record.claim_id ? { ...c, ...record } : c)) : prev));
  }, []);

  // Deep link: open the focused claim's drawer (the record may still be loading — the
  // drawer appears as soon as the list contains it).
  const focusNonce = focus?.nonce;
  useEffect(() => {
    if (!focus) return;
    openClaim(focus.claimId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  const decide = async (decision: 'approve' | 'deny') => {
    if (!selected || submitting) return;
    setSubmitting(decision);
    setSubmitError(null);
    const label = displayIdOf(selected) ?? selected.claim_id;
    try {
      await submitClaimDecision(selected.claim_id, decision, note.trim());
      const wantsReplacement = (selected.decision?.recommended_action ?? selected.decision?.action) === 'replacement';
      const nextStatus: ClaimStatus = decision === 'approve' ? (wantsReplacement ? 'replacement' : 'approved') : 'denied';
      setClaims(prev => (prev ?? []).map(c => (
        c.claim_id === selected.claim_id
          ? {
              ...c,
              status: nextStatus,
              decided_at: Date.now(),
              decision: {
                ...(c.decision ?? {}),
                action: decision === 'approve' ? (wantsReplacement ? 'replacement' : 'refund') : 'denied',
                by: 'human',
                note: note.trim() || c.decision?.note,
              },
            }
          : c
      )));
      setJustDecided(selected.claim_id);
      setNote('');
      toast.push({
        tone: 'good',
        text: t(decision === 'deny' ? 'desk.toast.denied' : wantsReplacement ? 'desk.toast.replacement' : 'desk.toast.approved').replace('{0}', label),
      });
      void refresh();
    } catch (e) {
      const message = (e as Error).message || t('desk.submitError');
      setSubmitError(message);
      toast.push({ tone: 'crit', text: t('desk.toast.failed').replace('{0}', message), ttl: 8000 });
    } finally {
      setSubmitting(null);
    }
  };

  const handleReset = async () => {
    if (!window.confirm(t('desk.resetConfirm'))) return;
    try {
      await resetDemo();
      toast.push({ tone: 'info', text: t('desk.toast.resetDone') });
    } catch (e) {
      console.error('[desk] reset failed', e);
      toast.push({ tone: 'crit', text: t('desk.toast.resetFailed').replace('{0}', (e as Error).message || ''), ttl: 8000 });
    }
    void refresh();
  };

  const handleNoteKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') closeClaim();
  };

  const selectedStatus = selected ? normalizeStatus(selected.status) : 'unknown';
  const selectedDisplayId = selected ? displayIdOf(selected) : undefined;

  return (
    <section className={styles.desk} aria-label={t('desk.title')}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{t('desk.title')}</h1>
          <p className={styles.subtitle}>{t('desk.subtitle')}</p>
        </div>
        <div className={styles.headRight}>
          <span className={`${styles.live} mono`} role="status" aria-live="polite">
            <span key={updatedAt ?? 0} className={`${styles.liveDot} ${offline ? styles.liveDotOff : ''} ${refreshing ? styles.liveDotBusy : ''}`} aria-hidden="true" />
            <span className={styles.liveWord}>{offline ? t('desk.offline') : t('desk.live')}</span>
            {updatedAt !== null && <span className={styles.liveTime}>· {t('desk.updated')} {fmtClock(updatedAt)}</span>}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={refreshing}>
            <IconRefresh size={13} />
            {t('desk.refresh')}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleReset()}
            disabled={refreshing}
            title={t('desk.resetConfirm')}
            data-testid="desk-reset"
          >
            <IconX size={13} />
            {t('desk.reset')}
          </button>
        </div>
      </header>

      <div className={styles.stats}>
        <StatTile label={t('desk.stat.autoApproval')} value={fmtPercent(autoRate)} sub={t('desk.stat.autoApprovalSub').replace('{0}', String(autoApproved)).replace('{1}', String(total))} />
        <StatTile label={t('desk.stat.refunded')} value={fmtMoney(refunded, stats?.currency ?? 'USD')} sub={t('desk.stat.refundedSub').replace('{0}', String(pendingCount)).replace('{1}', String(denied))} tone={pendingCount > 0 ? 'warn' : undefined} accent />
        <StatTile label={t('desk.stat.fraud')} value={String(fraudFlags)} sub={t('desk.stat.fraudSub')} tone={fraudFlags > 0 ? 'alert' : undefined} />
        <StatTile label={t('desk.stat.latency')} value={fmtLatency(medianLatency)} sub={t('desk.stat.latencySub')} />
      </div>

      <div className={styles.toolbar}>
        <div className={styles.filters} role="tablist" aria-label={t('desk.col.status')}>
          {FILTERS.map(f => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`${styles.chip} ${filter === f ? styles.chipActive : ''} ${f === 'pending_review' && (counts[f] ?? 0) > 0 ? styles.chipPending : ''}`}
              onClick={() => setFilter(f)}
              data-testid={`filter-${f}`}
            >
              {t(`desk.filter.${f}` as MessageKeys)}
              <span className={`${styles.chipCount} mono`}>{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.tableWrap} data-testid="desk-table-wrap">
        {claims === null ? (
          offline ? (
            <div className={styles.empty}>
              <span className={styles.emptyText}>{t('banner.offline')}</span>
            </div>
          ) : (
            <SkeletonTable />
          )
        ) : all.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}><IconInbox size={26} /></span>
            <span className={styles.emptyTitle}>{t('desk.empty')}</span>
            <span className={styles.emptyText}>{t('desk.emptyHint')}</span>
            <button type="button" className="btn btn-primary" onClick={onGoToChat}>
              {t('desk.emptyCta')}
              <IconArrowRight size={14} />
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className={styles.empty}><span className={styles.emptyText}>{t('desk.emptyFiltered')}</span></div>
        ) : (
          <table className={styles.table} data-testid="desk-table">
            <thead>
              <tr>
                <th>{t('desk.col.claim')}</th>
                <th>{t('desk.col.order')}</th>
                <th>{t('desk.col.customer')}</th>
                <th className={styles.numCol}>{t('desk.col.amount')}</th>
                <th>{t('desk.col.action')}</th>
                <th>{t('desk.col.fraud')}</th>
                <th>{t('desk.col.status')}</th>
                <th>{t('desk.col.decidedBy')}</th>
                <th className={styles.numCol}>{t('desk.col.time')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(c => (
                <ClaimRow key={c.claim_id} claim={c} selected={selectedId === c.claim_id} onOpen={() => openClaim(c.claim_id)} modeLabel={modeLabel} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Drawer
        open={selected !== null}
        onClose={closeClaim}
        side="right"
        width={460}
        label={t('desk.detail.title')}
        closeLabel={t('desk.detail.close')}
        title={selected ? (
          <span className={styles.drawerTitle}>
            <span className="kicker">{t('desk.detail.title')}</span>
            <span className="mono" title={selected.claim_id} data-testid="drawer-display-id">{selectedDisplayId}</span>
          </span>
        ) : null}
        headerExtra={selected ? <StatusPill status={selectedStatus} /> : null}
        footer={selected && selectedStatus === 'pending_review' ? (
          <div className={styles.decide}>
            <input
              className={styles.noteInput}
              value={note}
              onChange={e => setNote(e.target.value)}
              onKeyDown={handleNoteKey}
              placeholder={t('desk.notePlaceholder')}
              maxLength={280}
              disabled={submitting !== null}
              data-testid="decision-note"
            />
            <div className={styles.decideBtns}>
              <button type="button" className="btn btn-good" onClick={() => void decide('approve')} disabled={submitting !== null} data-testid="approve-btn">
                {(selected.decision?.recommended_action ?? '') === 'replacement' ? <IconSwap size={14} /> : <IconCheck size={14} strokeWidth={2.6} />}
                {submitting === 'approve' ? t('desk.submitting') : (selected.decision?.recommended_action ?? '') === 'replacement' ? t('desk.approveReplacement') : t('desk.approve')}
              </button>
              <button type="button" className="btn btn-crit" onClick={() => void decide('deny')} disabled={submitting !== null} data-testid="deny-btn">
                <IconX size={14} strokeWidth={2.6} />
                {submitting === 'deny' ? t('desk.submitting') : t('desk.deny')}
              </button>
            </div>
            {submitError && <span className={styles.error} role="alert">{t('desk.submitError')}: {submitError}</span>}
          </div>
        ) : null}
      >
        {selected && <ClaimDetail claim={selected} justDecided={justDecided === selected.claim_id} modeLabel={modeLabel} onTwinRecord={handleTwinRecord} />}
      </Drawer>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════ */

function StatTile({ label, value, sub, tone, accent }: { label: string; value: string; sub?: string; tone?: 'alert' | 'warn'; accent?: boolean }) {
  return (
    <div className={`${styles.stat} ${tone === 'alert' ? styles.statAlert : ''} ${tone === 'warn' ? styles.statWarn : ''} ${accent ? styles.statAccent : ''}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} tabular`}>{value}</span>
      {sub && <span className={styles.statSub}>{sub}</span>}
    </div>
  );
}

function SkeletonTable() {
  const { t } = useT();
  const widths = [72, 56, 64, 40, 70, 52, 68, 48, 44];
  return (
    <table className={`${styles.table} ${styles.skeleton}`} aria-busy="true" aria-label={t('desk.loading')} data-testid="desk-skeleton">
      <thead>
        <tr>
          <th>{t('desk.col.claim')}</th>
          <th>{t('desk.col.order')}</th>
          <th>{t('desk.col.customer')}</th>
          <th className={styles.numCol}>{t('desk.col.amount')}</th>
          <th>{t('desk.col.action')}</th>
          <th>{t('desk.col.fraud')}</th>
          <th>{t('desk.col.status')}</th>
          <th>{t('desk.col.decidedBy')}</th>
          <th className={styles.numCol}>{t('desk.col.time')}</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: SKELETON_ROWS }, (_, r) => (
          <tr key={r} aria-hidden="true">
            {widths.map((w, i) => (
              <td key={i} className={i === 3 || i === 8 ? styles.numCol : undefined}>
                <span className={styles.bone} style={{ width: `${w}%`, animationDelay: `${(r * 90) + (i * 30)}ms` }} />
                {(i === 0 || i === 2) && <span className={`${styles.bone} ${styles.boneSub}`} style={{ width: `${Math.round(w * 0.6)}%` }} />}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusPill({ status }: { status: ClaimStatus | 'unknown' }) {
  const { t } = useT();
  const label = status === 'unknown' ? '—' : t(`desk.status.${status}` as MessageKeys);
  const Icon =
    status === 'auto_approved' ? IconBolt :
    status === 'pending_review' ? IconClock :
    status === 'approved' ? IconCheck :
    status === 'denied' ? IconX :
    status === 'replacement' ? IconSwap :
    status === 'needs_info' ? IconHelp :
    IconMinus;
  return (
    <span className={`${styles.statusPill} ${styles[`st_${status}`] ?? styles.st_unknown}`} data-testid="status-pill-claim" data-status={status}>
      <Icon size={12} strokeWidth={2.5} />
      {label}
    </span>
  );
}

function ClaimRow({ claim: c, selected, onOpen, modeLabel }: { claim: ClaimRecord; selected: boolean; onOpen: () => void; modeLabel?: string }) {
  const { t } = useT();
  const status = normalizeStatus(c.status);
  const matches = fraudMatches(c);
  const checked = fraudChecked(c);
  const topScore = matches.reduce<number | undefined>((best, m) => (isNumber(m.score) && (best === undefined || m.score > best) ? m.score : best), undefined);
  const action = canonicalAction(c.decision?.action);
  const isPending = status === 'pending_review';
  const decidedMs = toMillis(c.decided_at);
  const displayId = displayIdOf(c) ?? c.claim_id;
  const name = customerNameOf(c);
  const named = hasCustomerName(c);
  const frame = evidenceFrameUrlOf(c);
  const mode = modeLabelOf(t, c.mode_label ?? modeLabel, c.model);
  const statusLabel = status === 'unknown' ? '' : t(`desk.status.${status}` as MessageKeys);
  const twinReady = normalizeTwin(c.twin)?.status === 'ready';

  return (
    <tr
      className={`${styles.row} ${selected ? styles.rowSelected : ''} ${isPending ? styles.rowPending : ''}`}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={[t('desk.openRow').replace('{0}', displayId), name, statusLabel].filter(Boolean).join(' · ')}
      data-testid="claim-row"
      data-claim-id={c.claim_id}
      data-status={status}
    >
      <td>
        <span className={styles.claimCell}>
          {frame && <EvidenceFrame src={frame} variant="thumb" />}
          <span className={styles.claimText}>
            <span className={`${styles.primary} mono`} title={c.claim_id !== displayId ? c.claim_id : undefined}>
              {displayId}
              {twinReady && (
                <span className={styles.twinMark} role="img" aria-label={t('twin.ready')} title={t('twin.ready')} data-testid="twin-mark">
                  <IconFilm size={12} />
                </span>
              )}
            </span>
            <span className={styles.sub}>{fmtRelative(c.created_at)}</span>
          </span>
        </span>
      </td>
      <td className={styles.orderCell}>
        <span className={`${styles.primary} mono`}>{c.order_id ?? '—'}</span>
        <span className={styles.sub}>{c.sku ?? '—'}</span>
      </td>
      <td className={styles.nameCell}>
        <span className={named ? styles.primary : `${styles.primary} mono`}>{name ?? '—'}</span>
        {named && c.customer_id && <span className={`${styles.sub} mono`}>{c.customer_id}</span>}
      </td>
      <td className={`${styles.numCol} mono`}>
        {isNumber(c.decision?.amount) && c.decision.amount > 0 && status !== 'needs_info'
          ? <span className={styles.primary}>{fmtMoney(c.decision.amount, c.decision.currency ?? 'USD')}</span>
          : <span className={styles.muted}>—</span>}
      </td>
      <td><ActionBadge action={action} label={action ? undefined : (c.decision?.action ?? '—')} size="sm" /></td>
      <td>
        {!checked ? (
          <span className={styles.muted}>{t('desk.unchecked')}</span>
        ) : matches.length > 0 ? (
          <span className={styles.fraudBad}>
            <IconAlert size={12} />
            {matches.length} {matches.length === 1 ? t('desk.match') : t('desk.matches')}
            {topScore !== undefined && <span className={`${styles.sub} mono`}>{topScore.toFixed(2)}</span>}
          </span>
        ) : (
          <span className={styles.fraudOk}>0 {t('desk.matches')}</span>
        )}
      </td>
      <td><StatusPill status={status} /></td>
      <td>
        <span className={styles.by}>{c.decision?.by === 'human' ? t('desk.byHuman') : t('desk.byAgent')}</span>
        {mode && <span className={styles.sub}>{mode}</span>}
      </td>
      <td className={`${styles.numCol} mono`}>
        <span>{fmtClock(c.created_at)}</span>
        {decidedMs !== undefined && <span className={styles.sub}>{fmtLatency(c.latency_ms)}</span>}
      </td>
    </tr>
  );
}

function Field({ label, value, mono, title }: { label: string; value: ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={`${styles.fieldValue} ${mono ? 'mono' : ''}`} title={title}>{value}</span>
    </div>
  );
}

function ClaimDetail({ claim: c, justDecided, modeLabel, onTwinRecord }: { claim: ClaimRecord; justDecided: boolean; modeLabel?: string; onTwinRecord?: (record: ClaimRecord) => void }) {
  const { t } = useT();
  const status = normalizeStatus(c.status);
  const twin = normalizeTwin(c.twin);
  const matches = fraudMatches(c);
  const checked = fraudChecked(c);
  const action = canonicalAction(c.decision?.action);
  const clauses = Array.isArray(c.decision?.policy_clauses) ? c.decision.policy_clauses : [];
  const steps = stepsFromToolCalls(c.tool_calls);
  const decidedMs = toMillis(c.decided_at);
  const isPending = status === 'pending_review';
  const needsInfo = status === 'needs_info' || action === 'needs_info';
  const displayId = displayIdOf(c) ?? c.claim_id;
  const name = customerNameOf(c);
  const named = hasCustomerName(c);
  const frame = evidenceFrameUrlOf(c);
  const clipLabel = demoClipLabel(c.video_id, c.order_id);
  const mode = modeLabelOf(t, c.mode_label ?? modeLabel, c.model);
  const showAmount = isNumber(c.decision?.amount) && c.decision.amount > 0 && !needsInfo;

  return (
    <div className={styles.detail} data-testid="claim-detail">
      <div className={styles.detailHero}>
        <ActionBadge action={action} label={action ? undefined : (c.decision?.action ?? '—')} size="lg" />
        {showAmount && (
          <span className={`${styles.detailAmount} tabular`}>{fmtMoney(c.decision!.amount, c.decision!.currency ?? 'USD')}</span>
        )}
      </div>
      <p className={styles.detailLine}>
        {name && <span className={named ? styles.detailName : `${styles.detailName} mono`}>{name}</span>}
        <span className="mono">{[c.order_id, c.sku].filter(Boolean).join(' · ')}</span>
      </p>
      {c.claim_id !== displayId && (
        <p className={`${styles.detailRawId} mono`}>
          <span>{t('desk.detail.claimId')}</span> {c.claim_id}
        </p>
      )}

      {justDecided && (
        <div className={styles.noticeGood}><IconCheck size={14} strokeWidth={2.6} />{t('desk.decided')}</div>
      )}
      {isPending && (
        <div className={styles.noticeWarn}>
          <IconClock size={14} />
          <span>
            {named && name ? t('desk.detail.pendingHintNamed').replace('{0}', name) : t('desk.detail.pendingHint')}
            {c.decision?.recommended_action && <> <b>{t('desk.detail.recommended')}: {c.decision.recommended_action}</b></>}
          </span>
        </div>
      )}
      {needsInfo && !isPending && (
        <div className={styles.noticeInfo}>
          <IconHelp size={14} />
          <span>{t('desk.detail.needsInfoHint')}</span>
        </div>
      )}

      {isTwinVisible(twin) && (
        <section className={styles.detailSection} data-testid="drawer-twin">
          <h4 className="kicker">{t('twin.kicker')}</h4>
          <DamageTwinBlock claimId={c.claim_id} twin={twin} variant="drawer" onRecord={onTwinRecord} />
        </section>
      )}

      <section className={styles.detailSection}>
        <h4 className="kicker">{t('desk.detail.evidence')}</h4>
        {frame && <EvidenceFrame src={frame} className={styles.detailFrame} />}
        <p className={styles.detailText}>{c.evidence_summary || '—'}</p>
        {c.damage_assessment && <p className={styles.detailMuted}>{c.damage_assessment}</p>}
        {c.video_id && (
          <p className={styles.detailClip}>
            <span className={styles.detailClipLabel}>
              <span className={styles.detailKicker}>{t('trace.clip')}</span>
              {clipLabel ?? c.video_id}
              {clipLabel && <i className={styles.demoTag}>{t('evidence.demoBadge')}</i>}
            </span>
            {clipLabel && <span className={`${styles.detailMuted} mono`}>{c.video_id}</span>}
          </p>
        )}
      </section>

      <section className={styles.detailSection}>
        <h4 className="kicker">{t('desk.detail.fraud')}</h4>
        {!checked ? (
          <p className={styles.detailMuted}>{t('desk.detail.fraudUnchecked')}</p>
        ) : matches.length === 0 ? (
          <p className={`${styles.detailText} ${styles.fraudOk}`}>{t('desk.detail.fraudNone')}</p>
        ) : (
          <div className={styles.matchBox}>
            <div className={styles.matchTitle}><IconAlert size={14} />{t('decision.fraudTitle')}</div>
            <ul className={styles.matchList}>
              {matches.map((m, i) => (
                <li key={`${m.video_id ?? ''}-${i}`} data-testid="drawer-fraud-match"><MatchLine match={m} /></li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className={styles.detailSection}>
        <h4 className="kicker">{t('desk.detail.trace')}</h4>
        <ol className={styles.traceList}>
          {steps.map(step => {
            const ms = stepElapsedMs(step, Date.now());
            return (
              <li key={step.id} className={`${styles.traceStep} ${styles[`tr_${step.status}`]}`}>
                <span className={styles.traceMarker} aria-hidden="true">
                  {step.status === 'done' ? <IconCheck size={11} strokeWidth={3} /> : step.status === 'error' ? <IconX size={11} strokeWidth={3} /> : <IconMinus size={11} strokeWidth={3} />}
                </span>
                <span className={styles.traceName}>{t(`trace.step.${step.id}` as MessageKeys)}</span>
                <span className={`${styles.traceTools} mono`}>{step.tools.join(' · ') || t(`trace.state.${step.status}` as MessageKeys)}</span>
                <span className={`${styles.traceTime} mono`}>{step.status === 'skipped' ? '—' : ms !== undefined && step.endedAt !== undefined ? fmtLatency(ms) : (step.id === 'record' ? t('trace.state.done') : '')}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className={styles.detailSection}>
        <h4 className="kicker">{t('desk.detail.clauses')}</h4>
        {clauses.length === 0 ? <p className={styles.detailMuted}>—</p> : (
          <ul className={styles.clauseList}>
            {clauses.map(cl => (
              <li key={cl}><span className={`${styles.clauseChip} mono`}>{cl.toUpperCase()}</span><span>{clauseText(cl)}</span></li>
            ))}
          </ul>
        )}
      </section>

      {(c.decision?.reason || c.decision?.note) && (
        <section className={styles.detailSection}>
          {c.decision?.reason && <><h4 className="kicker">{t('desk.detail.reason')}</h4><p className={styles.detailText}>{c.decision.reason}</p></>}
          {c.decision?.note && <><h4 className={`kicker ${styles.kickerGap}`}>{t('desk.detail.note')}</h4><p className={styles.detailText}>{c.decision.note}</p></>}
        </section>
      )}

      <section className={`${styles.detailSection} ${styles.fields}`}>
        <Field
          label={t('desk.detail.customer')}
          value={name ? (
            <>
              <span className={named ? undefined : 'mono'}>{name}</span>
              {named && c.customer_id && <span className={`${styles.fieldSub} mono`}>{c.customer_id}</span>}
            </>
          ) : '—'}
        />
        <Field label={t('desk.detail.txn')} value={c.decision?.txn_id ? <span className={styles.txn}>{c.decision.txn_id}</span> : '—'} mono title={c.decision?.txn_id} />
        <Field label={t('decision.latency')} value={fmtLatency(c.latency_ms)} mono />
        <Field label={t('desk.detail.mode')} value={mode ?? '—'} />
        <Field label={t('desk.detail.decidedAt')} value={decidedMs !== undefined ? `${new Date(decidedMs).toLocaleString()} · ${c.decision?.by === 'human' ? t('desk.byHuman') : t('desk.byAgent')}` : '—'} />
        <Field label={t('desk.detail.conversation')} value={c.conversation_id ?? '—'} mono title={c.conversation_id} />
      </section>
    </div>
  );
}
