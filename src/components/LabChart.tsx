import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { LabCurvePoint } from '../types';
import { useT } from '../i18n';
import styles from './LabView.module.css';

interface Props {
  /** Sorted ascending by threshold. */
  curve: LabCurvePoint[];
  recommended?: number;
  configured: number;
}

const H = 312;
const M = { top: 40, right: 72, bottom: 46, left: 50 };
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

/** Width of an element, live (the SVG draws in pixels so text never scales). */
function useElementWidth(ref: RefObject<HTMLElement>, initial: number): number {
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** Linear interpolation of a series at an arbitrary threshold. */
function valueAt(curve: LabCurvePoint[], key: 'recall' | 'fpr', v: number): number | undefined {
  if (curve.length === 0) return undefined;
  if (v <= curve[0].threshold) return curve[0][key];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (v <= b.threshold) {
      const span = b.threshold - a.threshold;
      const f = span > 0 ? (v - a.threshold) / span : 0;
      return a[key] + (b[key] - a[key]) * f;
    }
  }
  return curve[curve.length - 1][key];
}

/**
 * Recall and false-positive rate against the similarity threshold. Two series
 * (accent + aqua), the recommended threshold marked, the configured one dashed,
 * crosshair + tooltip on hover (arrow keys too), and the same numbers as a table.
 */
export default function LabChart({ curve, recommended, configured }: Props) {
  const { t } = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef, 720);
  const [hover, setHover] = useState<number | null>(null);

  const marks = recommended !== undefined ? [configured, recommended] : [configured];
  const thresholds = curve.map(p => p.threshold);
  const lo = Math.min(...thresholds, ...marks);
  const hi = Math.max(...thresholds, ...marks);
  const xMin = Math.max(0, Math.floor((lo - 0.02) * 20) / 20);
  const xMax = Math.min(1, Math.ceil((hi + 0.02) * 20) / 20);
  const span = xMax - xMin || 1;
  const plotW = Math.max(120, width - M.left - M.right);
  const plotH = H - M.top - M.bottom;
  const x = (v: number) => M.left + ((v - xMin) / span) * plotW;
  const y = (v: number) => M.top + (1 - clamp01(v)) * plotH;

  const linePath = (key: 'recall' | 'fpr') =>
    curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.threshold).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');

  // Tick step: the coarsest of 0.02 / 0.05 / 0.1 / 0.2 that keeps labels ≥ 52px apart.
  const step = [0.02, 0.05, 0.1, 0.2].find(s => (s / span) * plotW >= 52) ?? 0.2;
  const xTicks: number[] = [];
  for (let v = Math.ceil(xMin / step - 1e-9) * step; v <= xMax + 1e-9; v += step) xTicks.push(Math.round(v * 100) / 100);

  const nearestIndex = (v: number) => {
    let best = 0;
    for (let i = 1; i < curve.length; i++) {
      if (Math.abs(curve[i].threshold - v) < Math.abs(curve[best].threshold - v)) best = i;
    }
    return best;
  };
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (curve.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const v = xMin + ((e.clientX - rect.left - M.left) / plotW) * span;
    setHover(nearestIndex(v));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (curve.length === 0) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); setHover(h => Math.min(curve.length - 1, (h ?? -1) + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(h => Math.max(0, (h ?? curve.length) - 1)); }
    else if (e.key === 'Escape') setHover(null);
  };

  // Direct labels at the right end of each line: nudged apart when they collide,
  // and kept inside the plot so they never sit on the axis ticks.
  const last = curve[curve.length - 1];
  let recallLabelY = last ? y(last.recall) : 0;
  let fprLabelY = last ? y(last.fpr) : 0;
  if (last && Math.abs(recallLabelY - fprLabelY) < 14) {
    const mid = (recallLabelY + fprLabelY) / 2;
    if (recallLabelY <= fprLabelY) { recallLabelY = mid - 7; fprLabelY = mid + 7; }
    else { recallLabelY = mid + 7; fprLabelY = mid - 7; }
  }
  const labelTop = M.top + 6;
  const labelBottom = M.top + plotH - 4;
  const overflowDown = Math.max(recallLabelY, fprLabelY) - labelBottom;
  if (overflowDown > 0) { recallLabelY -= overflowDown; fprLabelY -= overflowDown; }
  const overflowUp = labelTop - Math.min(recallLabelY, fprLabelY);
  if (overflowUp > 0) { recallLabelY += overflowUp; fprLabelY += overflowUp; }

  // Threshold labels live above the plot; when the two lines are close the
  // recommended label takes the row above so neither covers the other.
  const sameMark = recommended !== undefined && Math.abs(recommended - configured) < 0.005;
  const marksClose = recommended !== undefined && !sameMark && Math.abs(x(recommended) - x(configured)) < 150;
  const configuredLabelY = M.top - 10;
  const recommendedLabelY = marksClose ? M.top - 24 : M.top - 10;
  const markAnchor = (v: number) => (x(v) > M.left + plotW * 0.72 ? { anchor: 'end' as const, dx: -6 } : { anchor: 'start' as const, dx: 6 });
  const hovered = hover !== null ? curve[hover] : null;
  const tooltipLeft = hovered ? x(hovered.threshold) : 0;
  const tooltipFlip = hovered ? tooltipLeft > width * 0.62 : false;

  return (
    <div className={styles.chartWrap} ref={wrapRef}>
      <div className={styles.legend} aria-hidden="true">
        <span className={styles.legendItem}><i className={`${styles.swatch} ${styles.swatchRecall}`} />{t('lab.chart.recall')}</span>
        <span className={styles.legendItem}><i className={`${styles.swatch} ${styles.swatchFpr}`} />{t('lab.chart.fpr')}</span>
        {recommended !== undefined && (
          <span className={styles.legendItem}><i className={`${styles.swatch} ${styles.swatchSolid}`} />{t('lab.chart.recommended')} <b className="mono">{recommended.toFixed(2)}</b></span>
        )}
        <span className={styles.legendItem}><i className={`${styles.swatch} ${styles.swatchDashed}`} />{t('lab.chart.configured')} <b className="mono">{configured.toFixed(2)}</b></span>
      </div>

      <svg
        className={styles.chart}
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={t('lab.chart.title')}
        tabIndex={0}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onKeyDown={onKey}
        data-testid="lab-chart"
      >
        <title>{t('lab.chart.title')}</title>

        {/* grid + y axis */}
        {Y_TICKS.map(v => (
          <g key={v}>
            <line className={styles.grid} x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} />
            <text className={styles.axisText} x={M.left - 8} y={y(v) + 4} textAnchor="end">{pct(v)}</text>
          </g>
        ))}
        {/* x axis */}
        <line className={styles.axis} x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} />
        {xTicks.map(v => (
          <text key={v} className={styles.axisText} x={x(v)} y={M.top + plotH + 18} textAnchor="middle">{v.toFixed(2)}</text>
        ))}
        <text className={styles.axisTitle} x={M.left + plotW / 2} y={H - 8} textAnchor="middle">{t('lab.chart.x')}</text>
        <text className={styles.axisTitle} transform={`translate(14 ${M.top + plotH / 2}) rotate(-90)`} textAnchor="middle">{t('lab.chart.y')}</text>

        {/* threshold markers */}
        {sameMark ? (
          <g>
            <line className={styles.markSolid} x1={x(configured)} x2={x(configured)} y1={M.top} y2={M.top + plotH} />
            <text className={styles.markLabel} x={x(configured) + markAnchor(configured).dx} y={M.top - 10} textAnchor={markAnchor(configured).anchor}>
              {t('lab.chart.recommended')} · {t('lab.chart.configured')} {configured.toFixed(2)}
            </text>
          </g>
        ) : (
          <g>
            <line className={styles.markDashed} x1={x(configured)} x2={x(configured)} y1={M.top} y2={M.top + plotH} />
            <text className={styles.markLabel} x={x(configured) + markAnchor(configured).dx} y={configuredLabelY} textAnchor={markAnchor(configured).anchor}>
              {t('lab.chart.configured')} {configured.toFixed(2)}
            </text>
            {recommended !== undefined && (
              <>
                <line className={styles.markSolid} x1={x(recommended)} x2={x(recommended)} y1={M.top} y2={M.top + plotH} />
                <text className={styles.markLabel} x={x(recommended) + markAnchor(recommended).dx} y={recommendedLabelY} textAnchor={markAnchor(recommended).anchor}>
                  {t('lab.chart.recommended')} {recommended.toFixed(2)}
                </text>
              </>
            )}
          </g>
        )}

        {/* series */}
        <path className={styles.lineFpr} d={linePath('fpr')} />
        <path className={styles.lineRecall} d={linePath('recall')} />
        {curve.map((p, i) => (
          <g key={p.threshold}>
            <circle className={styles.dotFpr} cx={x(p.threshold)} cy={y(p.fpr)} r={hover === i ? 5.5 : 3.5} />
            <circle className={styles.dotRecall} cx={x(p.threshold)} cy={y(p.recall)} r={hover === i ? 5.5 : 3.5} />
          </g>
        ))}
        {recommended !== undefined && (() => {
          const r = valueAt(curve, 'recall', recommended);
          const f = valueAt(curve, 'fpr', recommended);
          return (
            <g>
              {f !== undefined && <circle className={styles.ring} cx={x(recommended)} cy={y(f)} r={7} />}
              {r !== undefined && <circle className={styles.ring} cx={x(recommended)} cy={y(r)} r={7} />}
            </g>
          );
        })()}

        {/* direct labels */}
        {last && (
          <>
            <text className={styles.endLabel} x={x(last.threshold) + 10} y={recallLabelY + 4}>{t('lab.chart.recall')}</text>
            <text className={styles.endLabel} x={x(last.threshold) + 10} y={fprLabelY + 4}>{t('lab.chart.fprShort')}</text>
          </>
        )}

        {/* crosshair */}
        {hovered && (
          <line className={styles.crosshair} x1={x(hovered.threshold)} x2={x(hovered.threshold)} y1={M.top} y2={M.top + plotH} />
        )}
      </svg>

      {hovered && (
        <div
          className={`${styles.tooltip} ${tooltipFlip ? styles.tooltipFlip : ''}`}
          style={{ left: tooltipLeft, top: M.top + 30 }}
          role="status"
          data-testid="lab-tooltip"
        >
          <span className={`${styles.tooltipHead} mono`}>{t('lab.chart.threshold')} {hovered.threshold.toFixed(2)}</span>
          <span className={styles.tooltipRow}><i className={`${styles.swatch} ${styles.swatchRecall}`} />{t('lab.chart.recall')}<b className="mono">{pct(hovered.recall)}</b></span>
          <span className={styles.tooltipRow}><i className={`${styles.swatch} ${styles.swatchFpr}`} />{t('lab.chart.fpr')}<b className="mono">{pct(hovered.fpr)}</b></span>
          <span className={styles.tooltipRow}><i className={styles.swatchBlank} />{t('lab.chart.precision')}<b className="mono">{pct(hovered.precision)}</b></span>
          <span className={styles.tooltipRow}><i className={styles.swatchBlank} />{t('lab.chart.f1')}<b className="mono">{hovered.f1.toFixed(2)}</b></span>
        </div>
      )}

      <details className={styles.tableDetails}>
        <summary>{t('lab.chart.table')}</summary>
        <table className={styles.curveTable}>
          <thead>
            <tr>
              <th>{t('lab.chart.threshold')}</th>
              <th>{t('lab.chart.recall')}</th>
              <th>{t('lab.chart.fpr')}</th>
              <th>{t('lab.chart.precision')}</th>
              <th>{t('lab.chart.f1')}</th>
            </tr>
          </thead>
          <tbody>
            {curve.map(p => (
              <tr key={p.threshold} className={recommended !== undefined && Math.abs(p.threshold - recommended) < 0.005 ? styles.curveRowRecommended : undefined}>
                <td className="mono">{p.threshold.toFixed(2)}</td>
                <td className="mono">{pct(p.recall)}</td>
                <td className="mono">{pct(p.fpr)}</td>
                <td className="mono">{pct(p.precision)}</td>
                <td className="mono">{p.f1.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
