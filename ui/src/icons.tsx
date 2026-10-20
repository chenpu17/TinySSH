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

export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><line x1="20.5" y1="20.5" x2="16" y2="16" /></Svg>
);

export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" /></Svg>
);

export const IconPencil = (p: IconProps) => (
  <Svg {...p}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></Svg>
);

export const IconStar = (p: IconProps) => (
  <Svg {...p}>
    <polygon points="12 2.5 14.9 8.6 21.5 9.5 16.7 14.1 17.9 20.7 12 17.5 6.1 20.7 7.3 14.1 2.5 9.5 9.1 8.6 12 2.5" />
  </Svg>
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

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>
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

// T41 远程文件浏览器
export const IconFolder = (p: IconProps) => (
  <Svg {...p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg {...p}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></Svg>
);

export const IconInbox = (p: IconProps) => (
  <Svg {...p}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></Svg>
);

// 监控条（命令框退役轮）：暂停/恢复采样切换钮（lucide pause/play 同形）
export const IconPause = (p: IconProps) => (
  <Svg {...p}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}><polygon points="6 3 20 12 6 21" /></Svg>
);

// 规格 §六「连接中」小 spinner（currentColor；旋转在 .spin，reduced-motion 下停转只留图形）
export const IconLoader = (p: IconProps) => (
  <Svg {...p}><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></Svg>
);

// 专注模式（F11 轮）：lucide maximize-2 / minimize-2 同形——四角向外的展开与向内的收拢
export const IconMaximize = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
  </Svg>
);

export const IconMinimize = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
  </Svg>
);

// —— 活动栏批次（活动栏轮）：lucide 同形描边 ——

// 连接视图（lucide server 同形：双层机箱 + 指示点）
export const IconServer = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
  </Svg>
);

// Agent 对话视图（lucide bot 同形：头身一体 + 双眼 + 天线）
export const IconBot = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" />
    <line x1="9" y1="13" x2="9.01" y2="13" /><line x1="15" y1="13" x2="15.01" y2="13" />
    <line x1="9" y1="17" x2="15" y2="17" />
  </Svg>
);

// 协作（lucide users 同形）
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

// 端口转发（lucide shuffle 同形）
export const IconShuffle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.8-1.1 2-1.7 3.3-1.7H22" />
    <path d="m18 2 4 4-4 4" /><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2" />
    <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8" /><path d="m18 14 4 4-4 4" />
  </Svg>
);

// 活动记录（lucide rows 同形）
export const IconRows = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /></Svg>
);

// 命令块（lucide layers 同形：三层堆叠）
export const IconBlocks = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 2 8.5 4.77L12 11.53 3.5 6.77 12 2z" />
    <path d="m3.5 11.77 8.5 4.76 8.5-4.76" /><path d="m3.5 16.77 8.5 4.76 8.5-4.76" />
  </Svg>
);
