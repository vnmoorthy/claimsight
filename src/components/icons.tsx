import type { SVGProps } from 'react';

/**
 * Small inline SVG icons (24-unit grid, stroke-based). Decorative by default —
 * pass `label` to expose an accessible name when an icon stands alone.
 */

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  label?: string;
}

function base({ size = 16, label, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': label ? undefined : true,
    role: label ? 'img' : undefined,
    focusable: 'false' as const,
    ...rest,
  };
}

/** Receipt with an eye — the ClaimSight monogram. */
export function LogoMark({ size = 22, label, ...rest }: IconProps) {
  return (
    <svg {...base({ size, label, ...rest })} strokeWidth={1.9}>
      {label && <title>{label}</title>}
      <path d="M5 3h14v17.5l-2.33-1.6L14.33 20.5 12 18.9l-2.33 1.6-2.34-1.6L5 20.5V3z" />
      <path d="M8.2 11c1.1-1.7 2.4-2.5 3.8-2.5s2.7.8 3.8 2.5c-1.1 1.7-2.4 2.5-3.8 2.5s-2.7-.8-3.8-2.5z" />
      <circle cx="12" cy="11" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconCheck(p: IconProps) { return <svg {...base(p)}><path d="M5 12.5l4.5 4.5L19 7" /></svg>; }
export function IconSwap(p: IconProps) { return <svg {...base(p)}><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>; }
export function IconFlag(p: IconProps) { return <svg {...base(p)}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>; }
export function IconX(p: IconProps) { return <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>; }
export function IconAlert(p: IconProps) { return <svg {...base(p)}><path d="M12 3.5 2.5 20h19L12 3.5z" /><path d="M12 9.5v4.5M12 17.5h.01" /></svg>; }
export function IconVideo(p: IconProps) { return <svg {...base(p)}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" /></svg>; }
export function IconReceipt(p: IconProps) { return <svg {...base(p)}><path d="M5 3h14v18l-2.33-1.6L14.33 21 12 19.4 9.67 21l-2.34-1.6L5 21V3z" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" /></svg>; }
export function IconSun(p: IconProps) { return <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /></svg>; }
export function IconMoon(p: IconProps) { return <svg {...base(p)}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></svg>; }
export function IconHistory(p: IconProps) { return <svg {...base(p)}><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 3.5V8H8" /><path d="M12 7.5V12l3 2" /></svg>; }
export function IconSend(p: IconProps) { return <svg {...base(p)}><path d="M4 12L20 4l-4 16-4-7-8-1z" /><path d="M12 13l8-9" /></svg>; }
export function IconStop(p: IconProps) { return <svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></svg>; }
export function IconPaperclip(p: IconProps) { return <svg {...base(p)}><path d="M20 11.5 11.7 19.8a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7L9.3 17.4a1.6 1.6 0 0 1-2.3-2.3l7.8-7.8" /></svg>; }
export function IconChevronDown(p: IconProps) { return <svg {...base(p)}><path d="M6 9l6 6 6-6" /></svg>; }
export function IconChevronRight(p: IconProps) { return <svg {...base(p)}><path d="M9 6l6 6-6 6" /></svg>; }
export function IconPlus(p: IconProps) { return <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>; }
export function IconTrash(p: IconProps) { return <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>; }
export function IconRefresh(p: IconProps) { return <svg {...base(p)}><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>; }
export function IconClose(p: IconProps) { return <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>; }
export function IconBolt(p: IconProps) { return <svg {...base(p)}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></svg>; }
export function IconClock(p: IconProps) { return <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>; }
export function IconUser(p: IconProps) { return <svg {...base(p)}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></svg>; }
export function IconSearch(p: IconProps) { return <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>; }
export function IconPackage(p: IconProps) { return <svg {...base(p)}><path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></svg>; }
export function IconBook(p: IconProps) { return <svg {...base(p)}><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5v-15z" /><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3" /></svg>; }
export function IconPlay(p: IconProps) { return <svg {...base(p)}><path d="M7 4.5v15l12-7.5-12-7.5z" /></svg>; }
export function IconDatabase(p: IconProps) { return <svg {...base(p)}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>; }
export function IconExternal(p: IconProps) { return <svg {...base(p)}><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>; }
export function IconInbox(p: IconProps) { return <svg {...base(p)}><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6l2-8z" /></svg>; }
export function IconMinus(p: IconProps) { return <svg {...base(p)}><path d="M5 12h14" /></svg>; }
export function IconDot(p: IconProps) { return <svg {...base(p)}><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" /></svg>; }
export function IconArrowRight(p: IconProps) { return <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>; }
export function IconInfo(p: IconProps) { return <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></svg>; }
export function IconHelp(p: IconProps) { return <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V14M12 17h.01" /></svg>; }
export function IconImage(p: IconProps) { return <svg {...base(p)}><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 15.5 15.5 11l-6 6" /></svg>; }
export function IconFilm(p: IconProps) { return <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></svg>; }
export function IconCopy(p: IconProps) { return <svg {...base(p)}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></svg>; }
export function IconFlask(p: IconProps) { return <svg {...base(p)}><path d="M9 3h6M10 3v6.2L4.6 18.4A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.4-2.6L14 9.2V3" /><path d="M7.5 15h9" /></svg>; }

export function IconSpinner({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })} style={{ animation: 'cs-spin .8s linear infinite', ...(rest.style ?? {}) }}>
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
    </svg>
  );
}

export function IconGitHub({ size = 16, label, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} focusable={"false" as const} {...rest}>
      {label && <title>{label}</title>}
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18a10.94 10.94 0 0 1 5.75 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.7 5.4-5.27 5.68.42.36.79 1.07.79 2.16 0 1.56-.01 2.81-.01 3.19 0 .31.21.67.8.56C20.21 21.39 23.5 17.07 23.5 12 23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}
