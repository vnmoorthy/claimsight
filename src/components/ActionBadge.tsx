import type { ClaimAction } from '../types';
import { useT, type MessageKeys } from '../i18n';
import { IconCheck, IconFlag, IconHelp, IconSwap, IconX, IconDot } from './icons';
import styles from './ActionBadge.module.css';

interface Props {
  action: ClaimAction | null;
  /** Override the default localized word (e.g. a raw backend action string). */
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Color-coded action pill: icon + word, never color alone. Used by the Decision Card and the desk. */
export default function ActionBadge({ action, label, size = 'md', className = '' }: Props) {
  const { t } = useT();
  const text = label ?? (action ? t(`decision.action.${action}` as MessageKeys) : t('decision.action.unknown'));
  const iconSize = size === 'lg' ? 16 : size === 'sm' ? 12 : 14;
  const Icon =
    action === 'refund' ? IconCheck :
    action === 'replacement' ? IconSwap :
    action === 'escalated' ? IconFlag :
    action === 'denied' ? IconX :
    action === 'needs_info' ? IconHelp :
    IconDot;
  return (
    <span className={`${styles.badge} ${styles[size]} ${action ? styles[action] : styles.unknown} ${className}`}>
      <Icon size={iconSize} strokeWidth={2.5} />
      <span>{text}</span>
    </span>
  );
}
