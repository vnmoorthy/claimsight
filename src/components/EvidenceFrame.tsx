import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import styles from './EvidenceFrame.module.css';

interface Props {
  /** Same-origin still from the clip (backend `evidence_frame_url` or the bundled demo frame). */
  src?: string;
  /** `card`: 16:9 with a caption (trace panel, drawer). `thumb`: 40×24 inline (desk table). */
  variant?: 'card' | 'thumb';
  className?: string;
}

/**
 * Evidence still frame. Renders nothing when there is no URL or the image
 * fails to load, so a missing frame never leaves a broken-image box behind.
 */
export default function EvidenceFrame({ src, variant = 'card', className = '' }: Props) {
  const { t } = useT();
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return null;

  if (variant === 'thumb') {
    return (
      <img
        className={`${styles.thumb} ${className}`}
        src={src}
        alt={t('desk.thumbAlt')}
        width={40}
        height={24}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        data-testid="evidence-thumb"
      />
    );
  }

  return (
    <figure className={`${styles.frame} ${className}`} data-testid="evidence-frame">
      <img
        className={styles.image}
        src={src}
        alt={t('trace.frameAlt')}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
      <figcaption className={`${styles.caption} mono`}>{t('trace.frameCaption')}</figcaption>
    </figure>
  );
}
