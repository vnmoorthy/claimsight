import { useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from './icons';
import styles from './Drawer.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  title?: ReactNode;
  side?: 'left' | 'right';
  width?: number;
  /** `light` keeps the page readable behind the panel (desk detail); `dark` focuses it (history). */
  scrim?: 'light' | 'dark';
  headerExtra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  closeLabel?: string;
}

/**
 * Slide-in panel used for Claims history, the narrow-screen Decision trace
 * and the Refund Desk claim detail. Stays mounted so it can animate out;
 * Escape and the scrim close it.
 */
export default function Drawer({
  open, onClose, label, title, side = 'right', width = 420, scrim = 'light', headerExtra, footer, children, closeLabel = 'Close',
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // Move focus into the dialog without scrolling the page.
    const id = window.setTimeout(() => panelRef.current?.focus({ preventScroll: true }), 30);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(id);
    };
  }, [open, onClose]);

  return (
    <div className={`${styles.root} ${open ? styles.open : ''} ${side === 'left' ? styles.left : styles.right} ${scrim === 'dark' ? styles.scrimDark : ''}`} aria-hidden={!open}>
      <div className={styles.scrim} onClick={onClose} />
      <div
        ref={panelRef}
        className={styles.panel}
        style={{ width: `min(${width}px, 100vw)` }}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {(title || headerExtra) && (
          <div className={styles.head}>
            <div className={styles.title}>{title}</div>
            {headerExtra}
            <button type="button" className={`iconBtn ${styles.close}`} onClick={onClose} aria-label={closeLabel} title={closeLabel}>
              <IconClose size={16} />
            </button>
          </div>
        )}
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.foot}>{footer}</div>}
      </div>
    </div>
  );
}
