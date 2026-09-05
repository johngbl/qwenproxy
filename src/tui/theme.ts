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
  disableMouse: "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
};

export const theme = {
  // Catppuccin Mocha / TokyoNight inspired TrueColor palette
  cyan: (s: string) => `\x1b[38;2;137;220;235m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[38;2;137;180;250m${s}\x1b[39m`,
  lavender: (s: string) => `\x1b[38;2;180;190;254m${s}\x1b[39m`,
  green: (s: string) => `\x1b[38;2;166;227;161m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[38;2;249;226;175m${s}\x1b[39m`,
  peach: (s: string) => `\x1b[38;2;250;179;135m${s}\x1b[39m`,

  red: (s: string) => `\x1b[38;2;243;139;168m${s}\x1b[39m`,
  white: (s: string) => `\x1b[38;2;205;214;244m${s}\x1b[39m`,
  gray: (s: string) => `\x1b[38;2;166;173;200m${s}\x1b[39m`,
  muted: (s: string) => `\x1b[38;2;108;112;134m${s}\x1b[39m`,
  dark: (s: string) => `\x1b[38;2;69;71;90m${s}\x1b[39m`,
  borderActive: (s: string) => `\x1b[38;2;137;180;250m${s}\x1b[39m`,
  borderInactive: (s: string) => `\x1b[38;2;69;71;90m${s}\x1b[39m`,
  bgSelected: (s: string) => `\x1b[48;2;49;50;68m\x1b[38;2;137;220;235m${s}\x1b[49m\x1b[39m`,
  bgHover: (s: string) => `\x1b[48;2;69;71;90m\x1b[38;2;205;214;244m${s}\x1b[49m\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
  inverse: (s: string) => `\x1b[7m${s}\x1b[27m`,
};

import { execSync } from "node:child_process";

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
  cross: "✗",
  warn: "⚠",
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
    // Specific BMP emojis that occupy 2 visual terminal cells (e.g. ✅, ❌, ✨, ⚠️, ☕, ⚡)
    const isBmpEmoji =
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

  const matchIndent = line.match(/^(\s+)/);
  const indent = matchIndent ? matchIndent[1] : "  ";

  const words = line.trim().split(" ");
  const wrapped: string[] = [];
  let current = indent;

  for (const word of words) {
    const test = current.trim().length > 0 ? `${current} ${word}` : `${indent}${word}`;
    if (stringWidth(test) <= maxWidth) {
      current = test;
    } else {
      if (current.trim().length > 0) wrapped.push(current);
      current = `${indent}${word}`;
    }
  }

  if (current.trim().length > 0) wrapped.push(current);
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
    const cleanTitle = ` ${stripAnsi(title)} `;
    const titleW = stringWidth(cleanTitle);
    if (titleW < innerW - 2) {
      const remainingH = innerW - titleW - 1;
      topHeader =
        borderColor(b.h) +
        titleColor(cleanTitle) +
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
    const cleanFooter = ` ${stripAnsi(footer)} `;
    const footerW = stringWidth(cleanFooter);
    if (footerW < innerW - 2) {
      const remainingH = innerW - footerW - 1;
      bottomFooter =
        borderColor(b.h) +
        footerColor(cleanFooter) +
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
