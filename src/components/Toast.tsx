import { useT } from '../i18n';
import { useToast } from '../lib/toast';
import { IconAlert, IconCheck, IconClose, IconInfo } from './icons';
import styles from './Toast.module.css';

/** Bottom-left toast stack. Always mounted so the live region exists before the first toast. */
export default function ToastViewport() {
  const { t } = useT();
  const { toasts, dismiss } = useToast();
  return (
    <div className={styles.viewport} role="status" aria-live="polite" aria-atomic="false" aria-label={t('toast.label')}>
      {toasts.map(item => (
        <div key={item.id} className={`${styles.toast} ${styles[item.tone]}`} data-testid="toast">
          <span className={styles.icon} aria-hidden="true">
            {item.tone === 'good' ? <IconCheck size={14} strokeWidth={2.6} /> : item.tone === 'crit' ? <IconAlert size={14} /> : <IconInfo size={14} />}
          </span>
          <span className={styles.text}>{item.text}</span>
          <button type="button" className={styles.close} onClick={() => dismiss(item.id)} aria-label={t('toast.dismiss')} title={t('toast.dismiss')}>
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
