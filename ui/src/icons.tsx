// 线性图标体系（T32）：lucide 风格 24×24 描边图形，currentColor 继承文字色。
// 只做交互控件（按钮/标签页）的图标；正文语句里的 ✓/✕/⚠ 等状态记号保持文本，
// 「控件用图形、行文用字符」的分界不打破。
import type { CSSProperties } from "react";

type IconProps = { size?: number; className?: string; style?: CSSProperties };

const Svg = ({ size = 15, className = "", style, children }: IconProps & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={"ico " + className}
    style={style}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <line x1="21" y1="4" x2="14" y2="4" /><line x1="10" y1="4" x2="3" y2="4" />
    <line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" />
    <line x1="21" y1="20" x2="16" y2="20" /><line x1="12" y1="20" x2="3" y2="20" />
    <line x1="14" y1="2" x2="14" y2="6" /><line x1="8" y1="10" x2="8" y2="14" />
    <line x1="16" y1="18" x2="16" y2="22" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}><line x1="5" y1="12" x2="19" y2="12" /><line x1="12" y1="5" x2="12" y2="19" /></Svg>
);

export const IconMinus = (p: IconProps) => (
  <Svg {...p}><line x1="5" y1="12" x2="19" y2="12" /></Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>
);

export const IconSplit = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></Svg>
);

export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" /></Svg>
);

export const IconPencil = (p: IconProps) => (
  <Svg {...p}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
  </Svg>
);

export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}><path d="m18 15-6-6-6 6" /></Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></Svg>
);

export const IconArrowDown = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Svg>
);

export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></Svg>
);
