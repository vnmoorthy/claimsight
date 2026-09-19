import { useEffect, useState } from 'react';
import type { RawSseEvent } from '../api';
import type { ClaimRecord, Decision, EvidenceStage, EvidenceState } from '../types';
import { useT, type MessageKeys } from '../i18n';
import { fmtLatency, shortId } from '../lib/format';
import { POLICY_CLAUSE_IDS, POLICY_CLAUSES } from '../lib/policyClauses';
import { stepElapsedMs, traceElapsedMs, type StepId, type TraceState, type TraceStep } from '../lib/trace';
import DebugPanel from './DebugPanel';
import {
  IconBook, IconCheck, IconChevronDown, IconDatabase, IconMinus, IconPackage, IconPlay, IconSearch, IconSpinner, IconVideo, IconX,
} from './icons';
import styles from './TracePanel.module.css';

export interface EvidenceView {
  label?: string;
  videoId?: string;
  summary?: string;
  source?: 'upload' | 'demo';
  status?: EvidenceState['status'];
  progress?: number;
  stage?: EvidenceStage;
}

interface Props {
  trace: TraceState;
  evidence: EvidenceView | null;
  decision: Decision | null;
  record: ClaimRecord | null;
  debugEvents: RawSseEvent[];
  onClearDebug: () => void;
}

const STEP_ICON: Record<StepId, (p: { size?: number }) => JSX.Element> = {
  order: IconPackage,
  policy: IconBook,
  evidence: IconVideo,
  fraud: IconSearch,
  execute: IconPlay,
  record: IconDatabase,
};

/** Ticks while the run is live so elapsed times move. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [active]);
  return active ? now : Date.now();
}

export default function TracePanel({ trace, evidence, decision, record, debugEvents, onClearDebug }: Props) {
  const { t } = useT();
  const running = trace.phase === 'running';
  const now = useNow(running);
  const [hoodOpen, setHoodOpen] = useState(false);

  const elapsed = traceElapsedMs(trace, now);
  const statusLine =
    trace.phase === 'idle' ? t('trace.idle') :
    trace.phase === 'running' ? t('trace.running') :
    trace.phase === 'stopped' ? t('trace.stopped') :
    trace.phase === 'error' ? t('trace.error') :
    t('trace.done').replace('{0}', fmtLatency(elapsed));

  const cited = new Set((decision?.policy_clauses ?? []).map(c => c.toUpperCase()));
  const claimId = trace.claimId ?? decision?.claim_id;
  const summary = record?.evidence_summary || decision?.evidence || evidence?.summary;
  const damage = record?.damage_assessment;

  return (
    <aside className={styles.panel} aria-label={t('trace.title')}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <span className={styles.title}>{t('trace.title')}</span>
          <span className={`${styles.statusLine} ${running ? styles.statusRunning : ''}`}>
            {running && <IconSpinner size={12} />}
            {statusLine}
          </span>
        </div>
        <div className={styles.headMeta}>
          {trace.mode && (
            <span className={`${styles.modeChip} mono`}>{t(`trace.mode.${trace.mode === 'deterministic' ? 'deterministic' : 'llm'}` as MessageKeys)}</span>
          )}
          {claimId && <span className={`${styles.claimId} mono`} title={claimId}>{claimId}</span>}
        </div>
      </div>

      <div className={styles.body}>
        {/* (a) Evidence */}
        <section className={styles.section}>
          <h3 className={`kicker ${styles.sectionTitle}`}>{t('trace.evidence')}</h3>
          {evidence?.videoId || evidence?.label ? (
            <div className={styles.evidenceCard}>
              <div className={styles.evidenceHead}>
                <span className={styles.evidenceIcon}><IconVideo size={15} /></span>
                <div className={styles.evidenceText}>
                  <span className={styles.evidenceLabel}>{evidence.label ?? evidence.videoId}</span>
                  <span className={`${styles.evidenceId} mono`}>
                    {evidence.videoId ? shortId(evidence.videoId, 18, 6) : '—'}
                    {evidence.source === 'demo' && <i className={styles.tag}>{t('evidence.demoBadge')}</i>}
                    {evidence.status === 'indexing' && <i className={styles.tagBusy}>{t('evidence.indexing')} · {evidence.progress ?? 0}%</i>}
                    {evidence.status === 'uploading' && <i className={styles.tagBusy}>{t('evidence.uploading')}</i>}
                  </span>
                </div>
              </div>
              {summary ? (
                <div className={styles.summary}>
                  <span className={styles.summaryKicker}>{t('trace.evidenceSummary')}</span>
                  <p>{summary}</p>
                  {damage && <p className={styles.damage}><span>{t('trace.damage')}</span> {damage}</p>}
                </div>
              ) : (
                <p className={styles.hint}>{t('trace.evidencePending')}</p>
              )}
            </div>
          ) : (
            <p className={styles.hint}>{t('trace.evidenceNone')}</p>
          )}
        </section>

        {/* (b) Step timeline */}
        <section className={styles.section}>
          <h3 className={`kicker ${styles.sectionTitle}`}>{t('trace.steps')}</h3>
          <ol className={styles.steps}>
            {trace.steps.map(step => (
              <StepRow key={step.id} step={step} now={now} />
            ))}
          </ol>
          {(trace.traceId !== undefined || trace.agentxEmitted !== undefined) && (
            <p className={`${styles.agentx} mono`}>
              <span>{t('trace.agentx')}</span>
              <span className={trace.agentxEmitted ? styles.agentxOn : ''}>
                {trace.agentxEmitted ? t('trace.agentxSent') : t('trace.agentxSkipped')}
                {trace.traceId ? ` · ${shortId(trace.traceId, 10, 4)}` : ''}
              </span>
            </p>
          )}
        </section>

        {/* (c) Policy clauses */}
        <section className={styles.section}>
          <h3 className={`kicker ${styles.sectionTitle}`}>{t('trace.policy')}</h3>
          <ul className={styles.clauses}>
            {POLICY_CLAUSE_IDS.map(id => {
              const on = cited.has(id);
              return (
                <li key={id} className={`${styles.clause} ${on ? styles.clauseOn : ''} ${decision && !on ? styles.clauseOff : ''}`}>
                  <span className={`${styles.clauseId} mono`}>{id}</span>
                  <span className={styles.clauseText}>{POLICY_CLAUSES[id]}</span>
                  {on && <IconCheck size={13} strokeWidth={2.6} className={styles.clauseTick} />}
                </li>
              );
            })}
          </ul>
          {!decision && <p className={styles.hint}>{t('trace.policyHint')}</p>}
        </section>

        {/* (d) Under the hood */}
        <section className={`${styles.section} ${styles.hood}`}>
          <button
            type="button"
            className={styles.hoodToggle}
            onClick={() => setHoodOpen(v => !v)}
            aria-expanded={hoodOpen}
            aria-controls="trace-under-the-hood"
          >
            <IconChevronDown size={14} className={`${styles.hoodChevron} ${hoodOpen ? styles.hoodChevronOpen : ''}`} />
            <span className={`kicker ${styles.sectionTitle}`}>{t('trace.underHood')}</span>
            <span className={`${styles.hoodCount} mono`}>{t('trace.events').replace('{0}', String(debugEvents.length))}</span>
          </button>
          {hoodOpen && (
            <div id="trace-under-the-hood" className={styles.hoodBody}>
              <DebugPanel events={debugEvents} onClear={onClearDebug} />
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function StepRow({ step, now }: { step: TraceStep; now: number }) {
  const { t } = useT();
  const Icon = STEP_ICON[step.id];
  const elapsed = stepElapsedMs(step, now);
  const stateLabel = t(`trace.state.${step.status}` as MessageKeys);
  return (
    <li className={`${styles.step} ${styles[`st_${step.status}`]}`} aria-label={`${t(`trace.step.${step.id}` as MessageKeys)}: ${stateLabel}`}>
      <span className={styles.stepMarker} aria-hidden="true">
        {step.status === 'done' ? <IconCheck size={12} strokeWidth={3} /> :
         step.status === 'running' ? <IconSpinner size={12} /> :
         step.status === 'error' ? <IconX size={12} strokeWidth={3} /> :
         step.status === 'skipped' ? <IconMinus size={12} strokeWidth={3} /> :
         <span className={styles.stepDot} />}
      </span>
      <span className={styles.stepIcon} aria-hidden="true"><Icon size={14} /></span>
      <span className={styles.stepBody}>
        <span className={styles.stepName}>{t(`trace.step.${step.id}` as MessageKeys)}</span>
        <span className={`${styles.stepTools} mono`}>
          {step.tools.length > 0 ? step.tools.join(' · ') : stateLabel}
        </span>
      </span>
      <span className={`${styles.stepTime} mono`}>
        {elapsed !== undefined ? fmtLatency(elapsed) : step.status === 'skipped' ? '—' : ''}
      </span>
    </li>
  );
}
