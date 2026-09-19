import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LabClip, LabCurvePoint, LabResults } from '../types';
import { fetchLabResults } from '../api';
import { useT, type MessageKeys } from '../i18n';
import { fmtLatency, fmtRelative } from '../lib/format';
import { BLENDER_README_URL } from '../lib/links';
import { useToast } from '../lib/toast';
import LabChart from './LabChart';
import { IconAlert, IconCheck, IconCopy, IconExternal, IconFlask, IconRefresh, IconSpinner } from './icons';
import styles from './LabView.module.css';

/** The fraud check's similarity threshold when GET /stats does not expose one. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

const PRODUCT_KEYS: readonly string[] = ['mug', 'headphones', 'lamp', 'vase', 'tshirt', 'generic'];

type Translate = (key: MessageKeys) => string;

interface Props {
  /** `fraud_similarity_threshold` from GET /stats, when the backend exposes it. */
  configuredThreshold?: number;
}

type LoadState = { status: 'loading' | 'empty' | 'ready'; results: LabResults | null };

/** The curve point closest to a threshold. */
export function curveAt(curve: LabCurvePoint[], threshold: number): LabCurvePoint | undefined {
  let best: LabCurvePoint | undefined;
  for (const p of curve) {
    if (!best || Math.abs(p.threshold - threshold) < Math.abs(best.threshold - threshold)) best = p;
  }
  return best;
}

/** 0–1 → "75%", with one decimal for small rates ("1.6%"). */
export function fmtRate(v?: number): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  return pct > 0 && pct < 10 && Math.round(pct) !== pct ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

function fmtThreshold(n?: number): string {
  return n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(2);
}

function fmtDelta(n: number): string {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
}

function isMemoriesDetector(detector: string): boolean {
  return detector.toLowerCase().includes('memories');
}

function detectorLabel(t: Translate, detector: string): string {
  const key = detector.toLowerCase();
  if (isMemoriesDetector(detector)) return t('lab.detector.memories');
  if (key.includes('local') || key.includes('hash') || key.includes('baseline')) return t('lab.detector.local');
  return detector;
}

function productLabel(t: Translate, product: string): string {
  return PRODUCT_KEYS.includes(product) ? t(`lab.product.${product}` as MessageKeys) : product;
}

/** Render the `backticked` span of a string as <code>. */
function withCode(text: string): ReactNode {
  const parts = text.split(/`([^`]+)`/g);
  return parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>));
}

function legacyCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('copy rejected');
}

/**
 * Synthetic Evidence Lab — reads public/lab/results.json (written by
 * `npm run lab`): headline tiles, the recall / false-positive curve against
 * the similarity threshold, the clip gallery with each clip's top matches, and
 * a note on how the clips and the detector work.
 */
export default function LabView({ configuredThreshold }: Props) {
  const { t } = useT();
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading', results: null });
  const [openClip, setOpenClip] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState(prev => ({ ...prev, status: 'loading' }));
    const results = await fetchLabResults();
    setState({ status: results ? 'ready' : 'empty', results });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const results = state.results;
  const configured = configuredThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const recommended = results?.recommended_threshold ?? configured;
  const clips = useMemo(() => results?.clips ?? [], [results]);
  const byId = useMemo(() => new Map(clips.map(c => [c.clip_id, c])), [clips]);

  const summaryText = () => {
    if (!results) return '';
    const s = results.summary;
    const at = curveAt(results.curve, recommended);
    return [
      `${t('app.name')} · ${t('lab.title')}${results.generated_at ? ` · ${results.generated_at}` : ''}`,
      `${t('lab.tile.detector')}: ${detectorLabel(t, results.detector)}${results.collection_id ? ` (${results.collection_id})` : ''} · ${t('lab.tile.clips')}: ${s.clips ?? clips.length} · ${t('lab.tile.pairs')}: ${s.twin_pairs ?? 0}`,
      `${t('lab.tile.threshold')}: ${fmtThreshold(recommended)} (${t('lab.chart.configured')} ${fmtThreshold(configured)})`,
      `${t('lab.tile.recall')} ${fmtRate(s.recall ?? at?.recall)} · ${t('lab.tile.fpr')} ${fmtRate(s.fpr ?? at?.fpr)} · ${t('lab.chart.precision')} ${fmtRate(s.precision ?? at?.precision)} · ${t('lab.tile.mirrored')} ${fmtRate(s.mirrored_recall)}`,
      `${t('lab.tile.render')}: ${s.render_seconds !== undefined ? fmtLatency(s.render_seconds * 1000) : '—'}`,
    ].join('\n');
  };

  const copySummary = async () => {
    const text = summaryText();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else legacyCopy(text);
      toast.push({ tone: 'good', text: t('lab.copied') });
    } catch {
      toast.push({ tone: 'crit', text: t('lab.copyFailed'), ttl: 8000 });
    }
  };

  return (
    <section className={styles.lab} aria-label={t('lab.title')} data-testid="lab-view">
      <div className={styles.inner}>
        <header className={styles.head}>
          <div className={styles.headText}>
            <h1 className={styles.title}>
              <span className={styles.titleIcon} aria-hidden="true"><IconFlask size={18} /></span>
              {t('lab.title')}
            </h1>
            <p className={styles.subtitle}>{t('lab.subtitle')}</p>
          </div>
          <div className={styles.headRight}>
            {results?.generated_at && (
              <span className={`${styles.meta} mono`} title={results.generated_at}>{t('lab.generated').replace('{0}', fmtRelative(results.generated_at))}</span>
            )}
            {results && (
              <span className={`${styles.detectorChip} ${isMemoriesDetector(results.detector) ? styles.detectorLive : ''} mono`} data-testid="lab-detector">
                {detectorLabel(t, results.detector)}
              </span>
            )}
            <button type="button" className="btn btn-sm" onClick={() => void copySummary()} disabled={!results} data-testid="lab-copy">
              <IconCopy size={13} />
              {t('lab.copy')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={state.status === 'loading'} data-testid="lab-reload">
              {state.status === 'loading' ? <IconSpinner size={13} /> : <IconRefresh size={13} />}
              {t('lab.reload')}
            </button>
          </div>
        </header>

        {!results ? (
          state.status === 'loading' ? (
            <div className={styles.empty} role="status" aria-live="polite" data-testid="lab-loading">
              <IconSpinner size={20} />
              <span className={styles.emptyText}>{t('lab.loading')}</span>
            </div>
          ) : (
            <div className={styles.empty} data-testid="lab-empty">
              <span className={styles.emptyIcon}><IconFlask size={26} /></span>
              <span className={styles.emptyTitle}>{t('lab.emptyTitle')}</span>
              <p className={styles.emptyText}>{withCode(t('lab.emptyHint'))}</p>
              <a className={`btn ${styles.readme}`} href={BLENDER_README_URL} target="_blank" rel="noopener noreferrer">
                {t('lab.readme')}
                <IconExternal size={13} />
              </a>
            </div>
          )
        ) : (
          <LabContent
            results={results}
            clips={clips}
            byId={byId}
            recommended={recommended}
            configured={configured}
            openClip={openClip}
            onToggleClip={id => setOpenClip(prev => (prev === id ? null : id))}
          />
        )}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════ */

function LabContent({ results, clips, byId, recommended, configured, openClip, onToggleClip }: {
  results: LabResults;
  clips: LabClip[];
  byId: Map<string, LabClip>;
  recommended: number;
  configured: number;
  openClip: string | null;
  onToggleClip: (id: string) => void;
}) {
  const { t } = useT();
  const s = results.summary;
  const at = curveAt(results.curve, recommended);

  const clipsN = s.clips ?? clips.length;
  const damagedN = clips.filter(c => c.damaged).length;
  const intactN = Math.max(0, clips.length - damagedN);
  const pairsN = s.twin_pairs ?? clips.filter(c => c.twin_of).length;
  const mirroredN = clips.filter(c => c.twin_of && c.mirrored).length;
  const recall = s.recall ?? at?.recall;
  const fpr = s.fpr ?? at?.fpr;
  const precision = s.precision ?? at?.precision;
  const f1 = at?.f1;
  const delta = recommended - configured;
  const thresholdsMatch = Math.abs(delta) < 0.005;
  const renderS = s.render_seconds;
  const perClip = renderS !== undefined && clipsN > 0 ? renderS / clipsN : undefined;
  const memories = isMemoriesDetector(results.detector);

  return (
    <>
      <div className={styles.tiles} data-testid="lab-tiles">
        <Tile label={t('lab.tile.clips')} value={String(clipsN)} sub={t('lab.tile.clipsSub').replace('{0}', String(damagedN)).replace('{1}', String(intactN))} />
        <Tile label={t('lab.tile.pairs')} value={String(pairsN)} sub={t('lab.tile.pairsSub').replace('{0}', String(mirroredN))} />
        <Tile label={t('lab.tile.recall')} value={fmtRate(recall)} sub={t('lab.tile.recallSub').replace('{0}', fmtThreshold(recommended))} tone={recall !== undefined && recall >= 0.9 ? 'good' : recall !== undefined && recall < 0.6 ? 'alert' : undefined} />
        <Tile label={t('lab.tile.fpr')} value={fmtRate(fpr)} sub={t('lab.tile.fprSub').replace('{0}', fmtRate(precision)).replace('{1}', f1 !== undefined ? f1.toFixed(2) : '—')} tone={fpr !== undefined && fpr > 0.1 ? 'alert' : undefined} />
        <Tile
          label={t('lab.tile.threshold')}
          value={fmtThreshold(recommended)}
          sub={thresholdsMatch ? t('lab.tile.thresholdMatch') : t('lab.tile.thresholdSub').replace('{0}', fmtThreshold(configured)).replace('{1}', fmtDelta(delta))}
          tone={thresholdsMatch ? 'good' : 'accent'}
          testId="lab-tile-threshold"
        />
        <Tile label={t('lab.tile.detector')} value={detectorLabel(t, results.detector)} sub={memories ? t('lab.tile.detectorSub.memories') : t('lab.tile.detectorSub.local')} />
        <Tile label={t('lab.tile.render')} value={renderS !== undefined ? fmtLatency(renderS * 1000) : '—'} sub={t('lab.tile.renderSub').replace('{0}', perClip !== undefined ? fmtLatency(perClip * 1000) : '—')} />
        <Tile label={t('lab.tile.mirrored')} value={fmtRate(s.mirrored_recall)} sub={t('lab.tile.mirroredSub')} />
      </div>

      <section className={styles.card} aria-label={t('lab.chart.title')}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('lab.chart.title')}</h2>
          <p className={styles.cardHint}>{t('lab.chart.hint')}</p>
        </div>
        <LabChart curve={results.curve} recommended={results.recommended_threshold} configured={configured} />
      </section>

      <section className={styles.gallerySection} aria-label={t('lab.gallery.title')}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('lab.gallery.title')} <span className={`${styles.count} mono`}>{clips.length}</span></h2>
          <p className={styles.cardHint}>{t('lab.gallery.hint')}</p>
        </div>
        <ul className={styles.gallery} data-testid="lab-gallery">
          {clips.map(clip => (
            <ClipCard key={clip.clip_id} clip={clip} byId={byId} threshold={recommended} open={openClip === clip.clip_id} onToggle={() => onToggleClip(clip.clip_id)} />
          ))}
        </ul>
      </section>

      <section className={`${styles.card} ${styles.about}`} aria-label={t('lab.about.title')}>
        <h2 className={styles.cardTitle}>{t('lab.about.title')}</h2>
        <p>{t('lab.about.clips')}</p>
        <p>{t('lab.about.detector')}</p>
        <a className={styles.aboutLink} href={BLENDER_README_URL} target="_blank" rel="noopener noreferrer">
          {t('lab.readme')}
          <IconExternal size={12} />
        </a>
      </section>
    </>
  );
}

function Tile({ label, value, sub, tone, testId }: { label: string; value: string; sub?: string; tone?: 'good' | 'alert' | 'accent'; testId?: string }) {
  return (
    <div className={`${styles.tile} ${tone ? styles[`tile_${tone}`] : ''}`} data-testid={testId ?? 'lab-tile'}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={`${styles.tileValue} tabular`}>{value}</span>
      {sub && <span className={styles.tileSub}>{sub}</span>}
    </div>
  );
}

function ClipCard({ clip, byId, threshold, open, onToggle }: { clip: LabClip; byId: Map<string, LabClip>; threshold: number; open: boolean; onToggle: () => void }) {
  const { t } = useT();
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => { setImgFailed(false); }, [clip.poster]);

  const product = productLabel(t, clip.product);
  const damage = clip.damaged ? [clip.damage_location, clip.damage_type].filter(Boolean).join(' ') : '';
  const damageLabel = clip.damaged ? `${t('lab.badge.damaged')}${damage ? ` · ${damage}` : ''}` : t('lab.badge.intact');
  const badges = [product, damageLabel, clip.twin_of ? t('lab.badge.twinOf').replace('{0}', clip.twin_of) : null, clip.mirrored ? t('lab.badge.mirrored') : null].filter(Boolean);

  return (
    <li className={`${styles.clip} ${open ? styles.clipOpen : ''}`} data-testid="lab-clip" data-clip-id={clip.clip_id}>
      <button
        type="button"
        className={styles.clipBtn}
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${clip.clip_id} · ${badges.join(' · ')}`}
      >
        <span className={styles.posterWrap}>
          {!imgFailed && clip.poster ? (
            <img
              className={styles.poster}
              src={clip.poster}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImgFailed(true)}
              data-testid="lab-poster"
            />
          ) : (
            <span className={styles.posterFallback}>{product}</span>
          )}
          <span className={styles.matches}>
            <span className={styles.matchesTitle}>{t('lab.matches.title')}</span>
            {clip.top_matches.length === 0 && <span className={styles.matchNone}>{t('lab.matches.none')}</span>}
            {clip.top_matches.slice(0, 4).map(m => {
              const other = byId.get(m.clip_id);
              const isTwin = !!other && !!clip.group_id && other.group_id === clip.group_id;
              const above = m.score >= threshold;
              const tone = isTwin ? styles.matchTwin : above ? styles.matchFalse : '';
              return (
                <span key={m.clip_id} className={`${styles.match} ${tone}`}>
                  <span className={`${styles.matchId} mono`}>{m.clip_id}</span>
                  <span className={styles.matchBar} aria-hidden="true"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, m.score)) * 100)}%` }} /></span>
                  <b className={`${styles.matchScore} mono`}>{m.score.toFixed(2)}</b>
                  <span className={styles.matchTag}>
                    {isTwin ? <><IconCheck size={11} strokeWidth={3} />{t('lab.matches.twin')}</> : above ? <><IconAlert size={11} />{t('lab.matches.falsePositive')}</> : null}
                  </span>
                </span>
              );
            })}
          </span>
        </span>
        <span className={styles.clipMeta}>
          <span className={`${styles.clipId} mono`}>{clip.clip_id}</span>
          <span className={styles.badges}>
            <span className={`${styles.badge} ${styles.badgeProduct}`}>{product}</span>
            <span className={`${styles.badge} ${clip.damaged ? styles.badgeDamaged : styles.badgeIntact}`}>{damageLabel}</span>
            {clip.twin_of && <span className={`${styles.badge} ${styles.badgeTwin}`}>{t('lab.badge.twinOf').replace('{0}', clip.twin_of)}</span>}
            {clip.mirrored && <span className={`${styles.badge} ${styles.badgeMirrored}`}>{t('lab.badge.mirrored')}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}
