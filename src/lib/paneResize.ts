/**
 * 阅读器左右侧栏的可拖拽宽度：常量与纯函数。
 *
 * 这里刻意不依赖 React / DOM（只在外层包了 localStorage 读写），
 * 便于用 node 直接跑断言验证夹取逻辑。
 */

export interface PaneWidthConfig {
  /** localStorage 键；用户拖动后的宽度跨刷新保留。 */
  storageKey: string;
  /** 没有存档时的默认宽度（px）。 */
  defaultWidth: number;
  /** 可拖到的最窄值。 */
  minWidth: number;
  /** 可拖到的最宽值（还会被视口宽度进一步限制）。 */
  maxWidth: number;
}

export const READER_LEFT_PANE: PaneWidthConfig = {
  storageKey: "jusong.reader.leftPaneWidth",
  defaultWidth: 320,
  minWidth: 240,
  maxWidth: 480,
};

export const READER_RIGHT_PANE: PaneWidthConfig = {
  storageKey: "jusong.reader.rightPaneWidth",
  defaultWidth: 420,
  minWidth: 320,
  maxWidth: 720,
};

/**
 * 两侧栏之外，正文/中间面板至少保留的宽度。
 * 取 460px：保证阅读器顶部栏（左组 74 + 标题约 60 + 右组 150 + padding/间隔）不会被压缩到
 * 按钮与标题重叠；空间不够时优先收缩侧栏，而不是中间面板。
 */
export const MIN_READER_CONTENT_WIDTH = 460;

/**
 * 侧栏在哪个视口宽度开始内联显示（与 Tailwind lg 断点一致）。
 * 2026-11-16 平板断点修复：左右统一用 1024。
 * 此前 right = 1280（xl），导致 1024–1279 的平板即使空间足够（左右最窄 240 + 320 + 正文 460 = 1020）
 * 也看不到探索面板；现在 1024 起两栏都可内联展开，并由 resolveReaderPaneLayout 保证正文不被压到 460 以下。
 */
export const READER_PANE_BREAKPOINTS: Record<"left" | "right", number> = {
  left: 1024, // lg
  right: 1024, // lg（原 xl=1280）
};

/** 阅读器内联三栏模式从该宽度开始；更窄时由 settings.readerPanelMode 决定面板呈现方式。 */
export const READER_INLINE_LAYOUT_BREAKPOINT = READER_PANE_BREAKPOINTS.left;

/** 面板名称（栏头 aria / 弹窗标题）与顶栏按钮名称。 */
export const READER_PANE_TITLES: Record<"left" | "right", string> = {
  left: "知识面板",
  right: "探索面板",
};

export const READER_PANE_BUTTON_LABELS: Record<"left" | "right", string> = {
  left: "知识",
  right: "探索",
};

/** 空间不足 / 拖拽侧栏时的收缩优先级（与 settings.PaneShrinkPriority 结构一致）。 */
export type ReaderPaneShrinkPriority = "left" | "right" | "middle";

export function isReaderPaneVisible(side: "left" | "right", viewportWidth: number): boolean {
  return viewportWidth >= READER_PANE_BREAKPOINTS[side];
}

/** 键盘方向键单步、按住 Shift 的大步。 */
export const PANE_KEY_STEP = 16;
export const PANE_KEY_STEP_LARGE = 64;

/** 宽屏（2xl 及以上）右栏默认更宽，保持原有响应式观感。 */
export function defaultRightPaneWidth(viewportWidth: number): number {
  return viewportWidth >= 1536 ? 480 : READER_RIGHT_PANE.defaultWidth;
}

/** 窄屏内联推挤模式下，正文最少保留的宽度。 */
export const NARROW_INLINE_MIN_CONTENT = 200;
/** 窄屏内联推挤模式下，面板本身最少保留的宽度（窄屏可低于桌面最窄值）。 */
export const NARROW_INLINE_MIN_PANE = 160;

/** 夹取到 [min, max]；非有限数回落到 min。 */
export function clampPaneWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  const safeMin = Math.max(0, min);
  const safeMax = Math.max(safeMin, max);
  return Math.min(safeMax, Math.max(safeMin, Math.round(width)));
}

/**
 * 视口内这一侧栏还能占多宽：视口 - 另一侧已占宽度 - 正文最小宽度。
 * 结果仍受 minWidth/maxWidth 约束（空间不足时优先保证最窄可读宽度）。
 *
 * 说明：这是「拖动/键盘微调」时的单侧上限；窗口整体变窄时的自动分配见 resolveReaderPaneLayout。
 */
export function availablePaneWidth(input: {
  viewportWidth: number;
  reservedWidth?: number;
  minWidth: number;
  maxWidth: number;
  minContentWidth?: number;
}): number {
  const minContent = input.minContentWidth ?? MIN_READER_CONTENT_WIDTH;
  const reserved = Number.isFinite(input.reservedWidth ?? 0) ? (input.reservedWidth ?? 0) : 0;
  const room = input.viewportWidth - reserved - minContent;
  return clampPaneWidth(room, input.minWidth, input.maxWidth);
}

/** 参与内联布局的一侧面板。 */
export interface ReaderPaneSide {
  /** 该侧是否展开。 */
  open: boolean;
  /** 用户偏好宽度（面板宽度记忆）。 */
  preferredWidth: number;
  minWidth: number;
  maxWidth: number;
}

export interface ReaderPaneLayoutInput {
  viewportWidth: number;
  left: ReaderPaneSide;
  right: ReaderPaneSide;
  /** 空间不足时先收缩哪一侧。 */
  shrinkPriority: ReaderPaneShrinkPriority;
  minContentWidth?: number;
}

export interface ReaderPaneLayout {
  /** 左面板实际内联宽度（未展开为 0）。 */
  leftWidth: number;
  /** 右面板实际内联宽度（未展开为 0）。 */
  rightWidth: number;
  /** 中间正文实际可用宽度。 */
  contentWidth: number;
  /** 左/右面板是否被压到低于用户偏好宽度。 */
  leftShrunk: boolean;
  rightShrunk: boolean;
}

/**
 * 宽屏（≥ READER_INLINE_LAYOUT_BREAKPOINT）内联三栏的宽度分配：
 *
 * 1. 两侧栏优先保留用户偏好宽度；正文拿剩余空间。
 * 2. 若「两侧偏好宽度 + 正文最小宽度（默认 460）」超出视口，则正文钉在 460，缺口按
 *    settings.paneShrinkPriority 分配：
 *    - `left`  ：先收左（知识）面板到最窄，再收右（探索）面板；
 *    - `right` ：先收右面板到最窄，再收左面板；
 *    - `middle`：正文本身就是最先让步的一方（收到 460），剩余的缺口由两侧按各自可收缩余量
 *                 等比例分担，避免某一侧直接塌到最窄。
 * 3. 两侧都不会低于各自 minWidth；1024 起 240 + 320 + 460 = 1020 ≤ 1024，
 *    因此宽屏下正文恒 ≥ 460（视口更窄时走窄屏模式，不使用本函数）。
 */
export function resolveReaderPaneLayout(input: ReaderPaneLayoutInput): ReaderPaneLayout {
  const viewport = Math.max(0, Math.round(input.viewportWidth));
  const minContent = Math.max(0, input.minContentWidth ?? MIN_READER_CONTENT_WIDTH);
  const { left, right } = input;

  const leftPref = left.open ? clampPaneWidth(left.preferredWidth, left.minWidth, left.maxWidth) : 0;
  const rightPref = right.open
    ? clampPaneWidth(right.preferredWidth, right.minWidth, right.maxWidth)
    : 0;

  const settle = (l: number, r: number): ReaderPaneLayout => {
    const leftWidth = Math.round(l);
    const rightWidth = Math.round(r);
    return {
      leftWidth,
      rightWidth,
      contentWidth: Math.max(0, viewport - leftWidth - rightWidth),
      leftShrunk: leftWidth < Math.round(leftPref),
      rightShrunk: rightWidth < Math.round(rightPref),
    };
  };

  if (!left.open && !right.open) return settle(0, 0);
  if (viewport - leftPref - rightPref >= minContent) return settle(leftPref, rightPref);

  // 空间不足：正文先达到自己的下限，再决定侧栏怎么让。
  const budget = Math.max(0, viewport - minContent);

  if (!right.open) {
    // 只有左面板：最多占 budget（正文保持 460），视口过窄时也不低于自身最窄宽度。
    return settle(Math.min(leftPref, Math.max(left.minWidth, budget)), 0);
  }
  if (!left.open) {
    return settle(0, Math.min(rightPref, Math.max(right.minWidth, budget)));
  }

  const deficit = leftPref + rightPref - budget;
  let l = leftPref;
  let r = rightPref;

  if (input.shrinkPriority === "right") {
    const takeRight = Math.min(deficit, r - right.minWidth);
    r -= takeRight;
    const rest = deficit - takeRight;
    l -= Math.min(rest, l - left.minWidth);
  } else if (input.shrinkPriority === "middle") {
    // 正文已收到底：剩余缺口按两侧可收缩余量等比例分担。
    const leftRoom = Math.max(0, l - left.minWidth);
    const rightRoom = Math.max(0, r - right.minWidth);
    const room = leftRoom + rightRoom;
    if (room > 0) {
      if (deficit >= room) {
        l = left.minWidth;
        r = right.minWidth;
      } else {
        const takenLeft = Math.min(leftRoom, Math.round((leftRoom * deficit) / room));
        const takenRight = Math.min(rightRoom, deficit - takenLeft);
        l -= takenLeft;
        r -= takenRight;
        // 四舍五入后可能还剩 1px，从仍有收缩余量的一侧补足。
        const leftover = deficit - takenLeft - takenRight;
        if (leftover > 0) r = Math.max(right.minWidth, r - leftover);
        else if (leftover < 0) r = Math.min(rightPref, r - leftover);
      }
    }
  } else {
    // 默认：先收左（知识）面板，再收右（探索）面板。
    const takenLeft = Math.min(deficit, l - left.minWidth);
    l -= takenLeft;
    const rest = deficit - takenLeft;
    r -= Math.min(rest, r - right.minWidth);
  }

  return settle(l, r);
}

/**
 * 窄屏覆盖式抽屉（drawer）的面板宽度：保持面板尽量接近偏好宽度，
 * 但不超过视口的 88%，让左侧/右侧始终露出一条遮罩，点遮罩即可关闭。
 */
export function narrowDrawerWidth(preferredWidth: number, viewportWidth: number): number {
  const viewport = Math.max(1, Math.round(viewportWidth));
  const max = Math.max(200, Math.round(viewport * 0.88));
  return clampPaneWidth(Math.min(preferredWidth, max), Math.min(200, max), max);
}

/**
 * 窄屏内联推挤（inline）的面板宽度：面板进入布局，正文至少保留 NARROW_INLINE_MIN_CONTENT。
 * 窄屏下面板可低于桌面最窄宽度（159px 以下不再缩，避免面板不可用）。
 */
export function narrowInlinePaneWidth(preferredWidth: number, viewportWidth: number): number {
  const viewport = Math.max(1, Math.round(viewportWidth));
  const max = Math.max(NARROW_INLINE_MIN_PANE, viewport - NARROW_INLINE_MIN_CONTENT);
  return clampPaneWidth(
    preferredWidth,
    Math.min(NARROW_INLINE_MIN_PANE, max),
    max,
  );
}

/** 读存档宽度；缺失、损坏或越界都回落到默认值并夹取。 */
export function readStoredPaneWidth(
  storageKey: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const fallbackWidth = clampPaneWidth(fallback, min, max);
  if (typeof window === "undefined") return fallbackWidth;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return fallbackWidth;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampPaneWidth(parsed, min, max) : fallbackWidth;
  } catch {
    // 隐私模式下 localStorage 可能不可用。
    return fallbackWidth;
  }
}

export function storePaneWidth(storageKey: string, width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(Math.round(width)));
  } catch {
    // 写入失败只影响记忆，不影响当前宽度。
  }
}
