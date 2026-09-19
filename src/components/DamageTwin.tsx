import { useEffect, useRef, useState } from 'react';
import type { ClaimRecord, DamageTwin } from '../types';
import { useT } from '../i18n';
import { useDamageTwin } from '../lib/useDamageTwin';
import { IconFilm } from './icons';
import styles from './DamageTwin.module.css';

interface Props {
  claimId?: string;
  /** What the caller already knows about the twin (decision block, record or list item). */
  twin?: DamageTwin;
  /** `card`: inside the Decision Card (inherits its 16px gutters). `drawer`: inside the desk detail. */
  variant?: 'card' | 'drawer';
  /** Fired with every record the poll brings back — the desk uses it to keep its list fresh. */
  onRecord?: (record: ClaimRecord) => void;
}

/**
 * The Damage Twin: a Blender render of the product with the damage Memories.ai
 * described, placed on a 3D twin. While it renders (~25 s) a shimmering
 * placeholder counts the seconds; once ready the clip plays muted on loop.
 * Nothing renders for `unavailable`; `failed` leaves only a muted one-liner.
 */
export default function DamageTwinBlock({ claimId, twin: source, variant = 'card', onRecord }: Props) {
  const { t } = useT();
  const { twin, elapsedS } = useDamageTwin(claimId, source, onRecord);
  const [hover, setHover] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoUrl = twin?.status === 'ready' ? twin.video_url : undefined;

  useEffect(() => { setVideoFailed(false); }, [videoUrl]);

  // React sets `muted` as a property, not an attribute; make sure the element is
  // muted before asking it to autoplay, or Chromium refuses to start it.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoUrl) return;
    el.muted = true;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked — the poster stays */ });
  }, [videoUrl]);

  if (!twin || twin.status === 'unavailable') return null;
  const place = variant === 'drawer' ? styles.drawer : styles.card;

  if (twin.status === 'failed' || (twin.status === 'ready' && (!twin.video_url || videoFailed))) {
    return (
      <p className={`${styles.failed} ${place}`} data-testid="twin-failed">
        {twin.error === 'timeout' ? t('twin.timeout') : t('twin.failed')}
      </p>
    );
  }

  if (twin.status === 'queued' || twin.status === 'rendering') {
    return (
      <div
        className={`${styles.block} ${styles.pending} ${place}`}
        role="status"
        aria-live="polite"
        data-testid="twin-rendering"
        data-status={twin.status}
      >
        <span className={styles.shimmer} aria-hidden="true" />
        <span className={styles.pendingIcon} aria-hidden="true"><IconFilm size={15} /></span>
        <span className={styles.pendingBody}>
          <span className={styles.pendingTitle}>{t('twin.rendering')}</span>
          <span className={styles.pendingHint}>{t('twin.renderingHint')}</span>
        </span>
        <span className={`${styles.elapsed} mono`} data-testid="twin-elapsed">
          {t('twin.elapsed').replace('{0}', String(elapsedS))}
        </span>
      </div>
    );
  }

  const seconds = typeof twin.render_ms === 'number' ? (twin.render_ms / 1000).toFixed(1) : undefined;
  const caption = seconds ? t('twin.caption').replace('{0}', seconds) : t('twin.captionNoTime');

  return (
    <figure
      className={`${styles.block} ${styles.ready} ${place}`}
      data-testid="twin-ready"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onTouchStart={() => setHover(true)}
    >
      <video
        ref={videoRef}
        className={styles.video}
        src={twin.video_url}
        poster={twin.poster_url}
        muted
        autoPlay
        loop
        playsInline
        preload="metadata"
        controls={hover}
        aria-label={t('twin.alt')}
        onError={() => setVideoFailed(true)}
        data-testid="twin-video"
      />
      <figcaption className={`${styles.caption} mono`}>{caption}</figcaption>
    </figure>
  );
}
