/**
 * QwenProxy TUI - Visual Theme, ANSI TrueColor Palette & Box Drawing
 * Adheres to Monospace Design TUI Standard v0.2.5 (Catppuccin Mocha / TokyoNight palette)
 */

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  clearLine: "\x1b[2K",
  cursorHome: "\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  enterAltScreen: "\x1b[?1049h",
  exitAltScreen: "\x1b[?1049l",
  enableMouse: "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h",
  disableMouse: "\x1b[?1006l\x1b[?1005l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1015l",
};

export const theme = {
  // Official Qwen Logo & Web Dark Theme (Electric Violet #7B61FF / #615CED)
  cyan: (s: string) => `\x1b[38;2;123;97;255m${s}\x1b[39m`, // #7b61ff (Qwen Logo Electric Violet / Primary Highlight)
  blue: (s: string) => `\x1b[38;2;97;92;237m${s}\x1b[39m`, // #615ced (Qwen Deep Violet / Brand Theme)
  lavender: (s: string) => `\x1b[38;2;178;162;255m${s}\x1b[39m`, // #b2a2ff (Qwen Lilac / Iris Glow)
  green: (s: string) => `\x1b[38;2;8;229;166m${s}\x1b[39m`, // #08e5a6 (Qwen Success Mint)
  yellow: (s: string) => `\x1b[38;2;242;178;45m${s}\x1b[39m`, // #f2b22d (Qwen Caution Gold)
  peach: (s: string) => `\x1b[38;2;247;142;75m${s}\x1b[39m`, // #f78e4b (Qwen Warning Orange)

  red: (s: string) => `\x1b[38;2;252;109;109m${s}\x1b[39m`, // #fc6d6d (Qwen Danger Red)
  white: (s: string) => `\x1b[38;2;247;248;252m${s}\x1b[39m`, // #f7f8fc (Qwen Character Primary Text)
  gray: (s: string) => `\x1b[38;2;220;221;229m${s}\x1b[39m`, // #dcdde5 (Qwen Character Secondary Text)
  muted: (s: string) => `\x1b[38;2;121;123;137m${s}\x1b[39m`, // #797b89 (Qwen Character Quaternary Text)
  dark: (s: string) => `\x1b[38;2;53;53;61m${s}\x1b[39m`, // #35353d (Qwen Line Primary Border)
  borderActive: (s: string) => `\x1b[38;2;123;97;255m${s}\x1b[39m`, // #7b61ff (Qwen Logo Electric Violet Border)
  borderInactive: (s: string) => `\x1b[38;2;53;53;61m${s}\x1b[39m`, // #35353d (Qwen Line Primary Border)
  bgSelected: (s: string) => `\x1b[48;2;45;35;85m\x1b[38;2;247;248;252m${s}\x1b[49m\x1b[39m`, // #2d2355 Deep Violet + #f7f8fc White
  bgHover: (s: string) => `\x1b[48;2;58;46;110m\x1b[38;2;247;248;252m${s}\x1b[49m\x1b[39m`, // #3a2e6e Violet Hover + #f7f8fc White
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
  inverse: (s: string) => `\x1b[7m${s}\x1b[27m`,
};

import { execSync, spawnSync } from "node:child_process";

/**
 * Safely writes text to the system clipboard on Windows/macOS/Linux.
 * Also emits OSC 52 to copy inside terminal emulators supporting it.
 */
export function setClipboardText(text: string): boolean {
  try {
    // 1. Emit OSC 52 sequence for terminal emulators supporting it natively (only when interactive TTY)
    try {
      if (process.stdout.isTTY && !process.env.NODE_TEST_CONTEXT) {
        const b64 = Buffer.from(text, "utf-8").toString("base64");
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
      }
    } catch {}

    // 2. OS-level clipboard utility
    if (process.platform === "win32") {
      const p = spawnSync("clip.exe", {
        input: text,
        encoding: "utf-8",
        windowsHide: true,
      });
      return p.status === 0;
    } else if (process.platform === "darwin") {
      const p = spawnSync("pbcopy", { input: text, encoding: "utf-8" });
      return p.status === 0;
    } else {
      let p = spawnSync("wl-copy", { input: text, encoding: "utf-8" });
      if (p.status !== 0) {
        p = spawnSync("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf-8" });
      }
      return p.status === 0;
    }
  } catch {
    return false;
  }
}

/**
 * Safely reads the system clipboard text on Windows/macOS/Linux without throwing.
 */
export function getClipboardText(): string {
  try {
    if (process.platform === "win32") {
      return execSync("powershell -NoProfile -Command Get-Clipboard", {
        timeout: 1000,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      })
        .toString()
        .replace(/\r?\n/g, "")
        .trim();
    }
  } catch {}
  return "";
}

export const glyphs = {
  bullet: "●",
  circle: "○",
  pointer: "▸",
  arrowRight: "→",
  check: "✓",
  cross: "✕",
  warn: "⚠",
  reload: "↻",
  zap: "⚡",
  plus: "+",
  remove: "×",
  scissor: "✂",
  backspace: "⌫",
  broom: "🧹",
  enter: "↵",
  ellipsis: "…",
  blockFull: "█",
  blockDark: "▓",
  blockMed: "▒",
  blockLight: "░",
  radioOn: "(●)",
  radioOff: "( )",
  checkOn: "[x]",
  checkOff: "[ ]",
};

export const boxChars = {
  rounded: {
    tl: "╭",
    tr: "╮",
    bl: "╰",
    br: "╯",
    h: "─",
    v: "│",
    vl: "├",
    vr: "┤",
    hu: "┴",
    hd: "┬",
    cross: "┼",
  },
  single: {
    tl: "┌",
    tr: "┐",
    bl: "└",
    br: "┘",
    h: "─",
    v: "│",
    vl: "├",
    vr: "┤",
    hu: "┴",
    hd: "┬",
    cross: "┼",
  },
  double: {
    tl: "╔",
    tr: "╗",
    bl: "╚",
    br: "╝",
    h: "═",
    v: "║",
    vl: "╠",
    vr: "╣",
    hu: "╩",
    hd: "╦",
    cross: "╬",
  },
};

const ANSI_REGEX =
  /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x1b\x07]*(?:\x1b\\|\x07)|\([a-zA-Z])/g;

/**
 * Strips all ANSI and OSC escape codes (including OSC 8 hyperlinks) for accurate measurement.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

/**
 * Computes visual display width of string, accounting for wide characters and emojis.
 */
export function stringWidth(str: string): number {
  const clean = stripAnsi(str).replace(/\t/g, "  ").replace(/\r/g, "");
  let width = 0;
  for (const char of clean) {
    const code = char.codePointAt(0) || 0;
    // Zero-width characters (variation selectors, zero-width space/joiner)
    if ((code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x200b && code <= 0x200d)) {
      continue;
    }
    // Specific BMP emojis and symbols that occupy 2 visual terminal cells (e.g. ⚠️, ⚡, ✅, ❌, ✨, ☕)
    const isBmpEmoji =
      code === 0x26a0 || // ⚠️ (WARNING SIGN)
      code === 0x2705 || // ✅
      code === 0x2728 || // ✨
      code === 0x274c || // ❌
      code === 0x274e || // ❎
      code === 0x2753 || // ❓
      code === 0x2757 || // ❗
      code === 0x2b50 || // ⭐
      code === 0x2b55 || // ⭕
      code === 0x26a1 || // ⚡
      code === 0x2615 || // ☕
      code === 0x231a || // ⌚
      code === 0x231b || // ⌛
      code === 0x23f0 || // ⏰
      code === 0x23f3;   // ⏳
    // Common emoji and CJK full-width ranges (SMP Emojis 0x1f300 - 0x1faff)
    if (
      isBmpEmoji ||
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Truncates string to specified visual width with optional ellipsis.
 */
export function truncate(str: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  const clean = stripAnsi(str).replace(/\t/g, "  ").replace(/\r/g, "");
  if (stringWidth(clean) <= maxWidth) return str;

  const ellipsisW = stringWidth(ellipsis);
  const targetW = Math.max(0, maxWidth - ellipsisW);

  let currentW = 0;
  let cutIndex = 0;
  for (const char of clean) {
    const charW = stringWidth(char);
    if (currentW + charW > targetW) break;
    currentW += charW;
    cutIndex += char.length;
  }

  return clean.slice(0, cutIndex) + ellipsis;
}

/**
 * Pads string to target visual width with alignment.
 */
export function pad(
  str: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  const visualW = stringWidth(str);
  if (visualW >= width) return str;

  const diff = width - visualW;
  if (align === "right") {
    return " ".repeat(diff) + str;
  }
  if (align === "center") {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return " ".repeat(left) + str + " ".repeat(right);
  }
  return str + " ".repeat(diff);
}

/**
 * Word-wraps a content line to fit within maxWidth, preserving leading indentation.
 */
export function wrapContentLine(line: string, maxWidth: number): string[] {
  if (stringWidth(line) <= maxWidth) return [line];

  const clean = stripAnsi(line);
  if (stringWidth(clean) <= maxWidth) return [line];

  // Preserve leading ANSI styling prefix (e.g. colors, dim) and reset on each wrapped line
  const ansiMatch = line.match(/^(\x1b\[[0-9;]*m)+/);
  const ansiPrefix = ansiMatch ? ansiMatch[0] : "";
  const ansiSuffix = ansiPrefix ? "\x1b[0m" : "";

  // Preserve leading indentation from clean text
  const indentMatch = clean.match(/^(\s+)/);
  const indent = indentMatch ? indentMatch[1] : "  ";

  const words = clean.trim().split(/\s+/);
  const wrapped: string[] = [];
  let current = "";

  for (const word of words) {
    const test = current.length > 0 ? `${current} ${word}` : `${indent}${word}`;
    if (stringWidth(test) <= maxWidth) {
      current = test;
    } else {
      if (current.length > 0) {
        wrapped.push(ansiPrefix ? `${ansiPrefix}${current}${ansiSuffix}` : current);
      }
      current = `${indent}${word}`;
    }
  }

  if (current.length > 0) {
    wrapped.push(ansiPrefix ? `${ansiPrefix}${current}${ansiSuffix}` : current);
  }

  return wrapped.length > 0 ? wrapped : [line];
}

export interface BoxOptions {
  title?: string;
  footer?: string;
  width: number;
  height?: number;
  borderStyle?: "rounded" | "single" | "double";
  borderColor?: (s: string) => string;
  titleColor?: (s: string) => string;
  footerColor?: (s: string) => string;
  content: string[];
}

/**
 * Draws a beautiful bordered box with optional header, footer, and height constraint.
 */
export function drawBox(options: BoxOptions): string[] {
  const {
    title,
    footer,
    width,
    height,
    borderStyle = "rounded",
    borderColor = theme.borderInactive,
    titleColor = theme.cyan,
    footerColor = theme.muted,
    content,
  } = options;

  const b = boxChars[borderStyle];
  const innerW = Math.max(1, width - 2);
  const lines: string[] = [];

  // Top border
  let topHeader = "";
  if (title) {
    const hasAnsi = title.includes("\x1b[");
    const rawTitle = ` ${title} `;
    const cleanTitle = ` ${stripAnsi(title)} `;
    const titleW = stringWidth(cleanTitle);
    if (titleW < innerW - 2) {
      const remainingH = innerW - titleW - 1;
      topHeader =
        borderColor(b.h) +
        (hasAnsi ? rawTitle : titleColor(cleanTitle)) +
        borderColor(b.h.repeat(Math.max(0, remainingH)));
    } else if (innerW > 6) {
      const truncated = ` ${truncate(stripAnsi(title), innerW - 4)} `;
      const remainingH = Math.max(0, innerW - stringWidth(truncated) - 1);
      topHeader =
        borderColor(b.h) +
        titleColor(truncated) +
        borderColor(b.h.repeat(remainingH));
    } else {
      topHeader = borderColor(b.h.repeat(innerW));
    }
  } else {
    topHeader = borderColor(b.h.repeat(innerW));
  }
  lines.push(borderColor(b.tl) + topHeader + borderColor(b.tr));

  // Flatten and auto-wrap content lines so words are never cut off with ellipsis,
  // and strictly prevent any embedded \n or \r from leaking into a terminal row!
  const expandedContent: string[] = [];
  for (const item of content) {
    const subItems = String(item ?? "").split(/\r?\n/);
    for (const sub of subItems) {
      if (stringWidth(sub) <= innerW) {
        expandedContent.push(sub);
      } else {
        expandedContent.push(...wrapContentLine(sub, innerW));
      }
    }
  }
  // Content rows
  const maxContentRows = height ? Math.max(0, height - 2) : expandedContent.length;
  for (let i = 0; i < maxContentRows; i++) {
    const rawLine = i < expandedContent.length ? expandedContent[i] : "";
    const truncated = truncate(rawLine, innerW);
    const padded = pad(truncated, innerW);
    lines.push(borderColor(b.v) + padded + borderColor(b.v));
  }

  // Bottom border
  let bottomFooter = "";
  if (footer) {
    const hasAnsi = footer.includes("\x1b[");
    const rawFooter = ` ${footer} `;
    const cleanFooter = ` ${stripAnsi(footer)} `;
    const footerW = stringWidth(cleanFooter);
    if (footerW < innerW - 2) {
      const remainingH = innerW - footerW - 1;
      bottomFooter =
        borderColor(b.h) +
        (hasAnsi ? rawFooter : footerColor(cleanFooter)) +
        borderColor(b.h.repeat(Math.max(0, remainingH)));
    } else if (innerW > 6) {
      const truncated = ` ${truncate(stripAnsi(footer), innerW - 4)} `;
      const remainingH = Math.max(0, innerW - stringWidth(truncated) - 1);
      bottomFooter =
        borderColor(b.h) +
        footerColor(truncated) +
        borderColor(b.h.repeat(remainingH));
    } else {
      bottomFooter = borderColor(b.h.repeat(innerW));
    }
  } else {
    bottomFooter = borderColor(b.h.repeat(innerW));
  }
  lines.push(borderColor(b.bl) + bottomFooter + borderColor(b.br));
  return lines;
}
