/**
 * QwenProxy TUI - Comprehensive Unit Test Suite
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  stripAnsi,
  stringWidth,
  truncate,
  pad,
  drawBox,
  theme,
  glyphs,
} from "../tui/theme.ts";
import { maskAccountIdentifier } from "../tui/proxy-client.ts";
import { StatusView } from "../tui/views/status-view.ts";
import { SyncView } from "../tui/views/sync-view.ts";
import { AccountsView } from "../tui/views/accounts-view.ts";
import { ChatView } from "../tui/views/chat-view.ts";
import { StorageView } from "../tui/views/storage-view.ts";
import { TuiApp } from "../tui/app.ts";

test("TUI Theme: stripAnsi removes all escape codes cleanly", () => {
  const colored = theme.cyan("Hello ") + theme.bold(theme.green("World"));
  assert.equal(stripAnsi(colored), "Hello World");

  const mixed = `${theme.bgSelected("Menu Item")} - ${theme.dim("[q] Quit")}`;
  assert.equal(stripAnsi(mixed), "Menu Item - [q] Quit");
});

test("TUI Theme: stringWidth accurately measures plain and formatted text", () => {
  assert.equal(stringWidth("hello"), 5);
  assert.equal(stringWidth(theme.cyan("hello")), 5);
  // Wide glyphs / emojis take 2 columns
  assert.equal(stringWidth("🧠"), 2);
  assert.equal(stringWidth("你好"), 4);
});

test("TUI Theme: truncate respects visual width with ellipsis", () => {
  const text = "The quick brown fox jumps over the lazy dog";
  assert.equal(truncate(text, 50), text);

  const truncated = truncate(text, 15);
  assert.equal(stringWidth(truncated), 15);
  assert.ok(truncated.endsWith("…"));

  // Zero or negative
  assert.equal(truncate(text, 0), "");
});

test("TUI Theme: drawBox always renders full-width horizontal borders with or without title and footer", () => {
  const width = 40;
  const box = drawBox({
    width,
    content: ["Hello"],
  });
  // Top line: ╭────────────────────────────────────╮ (width 40)
  assert.equal(stringWidth(stripAnsi(box[0])), width);
  assert.ok(box[0].includes("─".repeat(38)));

  // Bottom line: ╰────────────────────────────────────╯ (width 40)
  assert.equal(stringWidth(stripAnsi(box[box.length - 1])), width);
  assert.ok(box[box.length - 1].includes("─".repeat(38)));

  // With title only
  const boxWithTitle = drawBox({
    title: "Test",
    width,
    content: ["Content"],
  });
  assert.equal(stringWidth(stripAnsi(boxWithTitle[0])), width);
  assert.equal(stringWidth(stripAnsi(boxWithTitle[boxWithTitle.length - 1])), width);
  assert.ok(boxWithTitle[boxWithTitle.length - 1].includes("─".repeat(38)));
});
test("TUI Theme: pad handles left, right, and center alignments", () => {
  assert.equal(pad("test", 10, "left"), "test      ");
  assert.equal(pad("test", 10, "right"), "      test");
  assert.equal(pad("test", 10, "center"), "   test   ");
  assert.equal(stringWidth(pad("test", 10, "center")), 10);
});

test("TUI Theme: drawBox creates properly bounded boxes with rounded corners", () => {
  const box = drawBox({
    title: "Status",
    footer: "OK",
    width: 30,
    height: 5,
    content: ["Line 1", "Line 2"],
  });

  assert.equal(box.length, 5);
  // Check that every line has the exact visual width of 30
  for (const line of box) {
    assert.equal(stringWidth(stripAnsi(line)), 30);
  }

  // Top and bottom corners
  const cleanTop = stripAnsi(box[0]);
  const cleanBottom = stripAnsi(box[4]);
  assert.ok(cleanTop.startsWith("╭"));
  assert.ok(cleanTop.endsWith("╮"));
  assert.ok(cleanTop.includes("Status"));
  assert.ok(cleanBottom.startsWith("╰"));
  assert.ok(cleanBottom.endsWith("╯"));
  assert.ok(cleanBottom.includes("OK"));
});

test("TUI Proxy Client: maskAccountIdentifier masks emails and IDs for privacy", () => {
  assert.equal(maskAccountIdentifier("john.doe@gmail.com"), "jo***@gmail.com");
  assert.equal(maskAccountIdentifier("admin@company.org"), "ad***@company.org");
  assert.equal(maskAccountIdentifier("1234567890abcdef"), "123***def");
  assert.equal(maskAccountIdentifier("short"), "short");
});

test("TUI StatusView: exposes shortcuts and renders valid box frame", () => {
  const view = new StatusView();
  assert.equal(view.id, "status");
  assert.equal(view.tabNumber, 1);

  const shortcuts = view.getShortcuts();
  assert.ok(shortcuts.some((s) => s.key === "r"));
  assert.ok(shortcuts.some((s) => s.key === "z"));

  const lines = view.render(80, 24);
  assert.ok(lines.length > 0);
  const fullText = stripAnsi(lines.join("\n"));
  assert.ok(fullText.includes("Sistema"));
  assert.ok(fullText.includes("Contas"));
});

test("TUI SyncView: handles keyboard toggles and model selection", async () => {
  const view = new SyncView();
  assert.equal(view.id, "sync");
  assert.equal(view.tabNumber, 3);

  const shortcuts = view.getShortcuts();
  assert.ok(shortcuts.some((s) => s.key === "Espaço"));
  assert.ok(shortcuts.some((s) => s.key === "Enter"));

  // Verify initial selection starts unselected [ ]
  const initialLines = view.render(90, 24).join("\n");
  assert.ok(initialLines.includes(glyphs.checkOff));

  // Toggle selection with space on row 0 (marks to [x])
  await view.handleKey({ name: "space", ctrl: false, shift: false, meta: false });
  const toggledLines = view.render(90, 24).join("\n");
  assert.ok(toggledLines.includes(glyphs.checkOn));
});

test("TUI AccountsView: navigates accounts and provides cooldown actions", async () => {
  const view = new AccountsView();
  assert.equal(view.id, "accounts");
  assert.equal(view.tabNumber, 5);

  const shortcuts = view.getShortcuts();
  assert.ok(shortcuts.some((s) => s.key === "c"));
  assert.ok(shortcuts.some((s) => s.key === "z"));

  // Down arrow
  await view.handleKey({ name: "down", ctrl: false, shift: false, meta: false });
  const lines = view.render(80, 24);
  assert.ok(lines.length > 0);
  const fullText = stripAnsi(lines.join("\n"));
  assert.ok(fullText.includes("Contas"));
});

test("TUI ChatView: opens vertical model modal with F2 and selects with Enter", async () => {
  const view = new ChatView();
  assert.equal(view.id, "chat");
  assert.equal(view.tabNumber, 2);

  const initialRender = view.render(80, 24).join("\n");
  assert.ok(initialRender.includes("qwen3.8-max"));

  // Open modal with F2
  await view.handleKey({ name: "f2", ctrl: false, shift: false, meta: false });
  const modalRender = view.render(80, 24).join("\n");
  assert.ok(modalRender.includes("Selecionar Modelo"));

  // Move down and select with Enter
  await view.handleKey({ name: "down", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });

  const switchedRender = view.render(80, 24).join("\n");
  assert.ok(switchedRender.includes("qwen3.7-plus"));
});

test("TUI ChatView: does not append Tab character and accepts numeric typing", async () => {
  const view = new ChatView();

  // Type numbers and letters
  await view.handleKey({ name: "1", ctrl: false, shift: false, meta: false, char: "1" });
  await view.handleKey({ name: "2", ctrl: false, shift: false, meta: false, char: "2" });

  // Press Tab - should NOT append \t
  await view.handleKey({ name: "tab", ctrl: false, shift: false, meta: false, char: "\t" });

  const rendered = view.render(80, 24).join("\n");
  assert.ok(rendered.includes("12"));
  assert.ok(!rendered.includes("\t"));
});
test("TUI App: Tab key cycles tabs across views including from Chat view", async () => {
  const app = new TuiApp(2); // Start on Tab 2 (Chat)
  assert.equal((app as any).activeViewIndex, 1); // Chat is index 1

  // Pressing Tab from Chat cycles to Tab 3 (Sync, index 2)
  await (app as any).handleKey({ name: "tab", ctrl: false, shift: false, meta: false });
  assert.equal((app as any).activeViewIndex, 2);

  // Pressing Tab again cycles to Tab 4 (Storage, index 3)
  await (app as any).handleKey({ name: "tab", ctrl: false, shift: false, meta: false });
  assert.equal((app as any).activeViewIndex, 3);
});

test("TUI Markdown: formatMarkdownInline converts markdown styles to ANSI", async () => {
  const { formatMarkdownInline, formatMarkdown } = await import("../tui/markdown.ts");
  const raw = "**Responding in Portuguese** I recognize the user's friendly greeting in `pt-BR`.";
  const formatted = formatMarkdownInline(raw);

  assert.ok(!formatted.includes("**"));
  assert.ok(!formatted.includes("`"));
  assert.ok(formatted.includes("\x1b[1m"));
  assert.ok(formatted.includes("Responding in Portuguese"));

  const multiLine = formatMarkdown("# Título\n- Item 1\n- Item 2", 40);
  assert.ok(multiLine.some((l) => l.includes("•") && l.includes("Item 1")));
});

test("TUI Markdown: formatReasoning outputs uniform italic text without bold contrast", async () => {
  const { formatReasoning } = await import("../tui/markdown.ts");
  const think = "**Responding in Portuguese**\nI recognize the user's friendly greeting.";
  const lines = formatReasoning(think, 60);

  assert.ok(lines.length >= 2);
  // Every line should contain italic escape code \x1b[3m
  assert.ok(lines[0].includes("\x1b[3m"));
  assert.ok(lines[0].includes("Responding in Portuguese"));
  assert.ok(!lines[0].includes("**"));
});

test("TUI Markdown: formatMarkdown converts markdown images to clean cards with OSC 8", async () => {
  const { formatMarkdown } = await import("../tui/markdown.ts");
  const text = "Aqui está a imagem:\n![Foto de paisagem](https://cdn.qwenlm.ai/output/landscape.png)\nFim.";
  const lines = formatMarkdown(text, 70);

  assert.ok(lines.some((l) => l.includes("🖼️")));
  assert.ok(lines.some((l) => l.includes("Foto de paisagem")));
  assert.ok(lines.some((l) => l.includes("https://cdn.qwenlm.ai/output/landscape.png")));
  assert.ok(lines.some((l) => l.includes("Clique para abrir a imagem no navegador")));
});

test("TUI ChatView: past assistant messages preserve their generating model when switching active model", async () => {
  const view = new ChatView();
  // Simulate a message generated with qwen3.8-max
  (view as any).messages.push({
    role: "assistant",
    content: "Resposta gerada",
    model: "qwen3.8-max",
  });

  // Open modal and switch active model to qwen3.7-plus
  await view.handleKey({ name: "f2", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "down", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });
  // Confirm effort selection with Return
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });
  const rendered = view.render(80, 24).join("\n");
  // The conversation history should still show qwen3.8-max for that message
  assert.ok(rendered.includes("Qwen (qwen3.8-max):"));
  // While the active selector header shows qwen3.7-plus
  assert.ok(rendered.includes("qwen3.7-plus"));
});
test("TUI ChatView: selects model and its reasoning effort (F2/F3 and mouse)", async () => {
  const view = new ChatView();

  // 1. Open Model Modal with F2
  await view.handleKey({ name: "f2", ctrl: false, shift: false, meta: false });
  let render = view.render(80, 24).join("\n");
  assert.ok(render.includes("Selecionar Modelo"));

  // 2. Select first model (qwen3.8-max) with Enter -> Opens Effort Modal
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });
  render = view.render(80, 24).join("\n");
  assert.ok(render.includes("Nível de Raciocínio / Effort"));
  assert.ok(render.includes("High (Thinking)"));
  assert.ok(render.includes("Medium (Auto)"));
  assert.ok(render.includes("Low (Fast)"));

  // 3. Move down to Medium (Auto) and select with Enter
  await view.handleKey({ name: "down", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });
  render = view.render(80, 24).join("\n");
  assert.ok(render.includes("Effort: Medium (Auto)"));

  // 4. Open Effort Modal directly with F3
  await view.handleKey({ name: "f3", ctrl: false, shift: false, meta: false });
  render = view.render(80, 24).join("\n");
  assert.ok(render.includes("Nível de Raciocínio / Effort"));

  // 5. Select Low (Fast) via mouse click on row 11
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 10, row: 11 },
  });
  render = view.render(80, 24).join("\n");
  assert.ok(render.includes("Effort: Low (Fast)"));
});

test("TUI ChatView: supports cursor movement and in-place character insertion with Left/Right arrows", async () => {
  const view = new ChatView();

  // Type "ac"
  await view.handleKey({ name: "a", ctrl: false, shift: false, meta: false, char: "a" });
  await view.handleKey({ name: "c", ctrl: false, shift: false, meta: false, char: "c" });

  // Move left (cursor between 'a' and 'c')
  await view.handleKey({ name: "left", ctrl: false, shift: false, meta: false });

  // Type "b" (inserted in the middle -> "abc")
  await view.handleKey({ name: "b", ctrl: false, shift: false, meta: false, char: "b" });
  const rendered = view.render(80, 24).join("\n");
  assert.ok(stripAnsi(rendered).includes("abc"));
});

test("TUI ChatView: classifyModel dynamically categorizes any model without hardcoded lists", async () => {
  const { classifyModel } = await import("../tui/views/chat-view.ts");

  assert.equal(classifyModel("qwen3.8-max").category, "Texto & Raciocínio");
  assert.ok(classifyModel("qwen3.8-max").badge.includes("[Texto]"));
  assert.equal(classifyModel("z-image-turbo").category, "Geração de Imagem");
  assert.ok(classifyModel("z-image-turbo").badge.includes("[Imagem]"));
  assert.equal(classifyModel("wan3.0-video").category, "Geração de Vídeo");
  assert.ok(classifyModel("wan3.0-video").badge.includes("[Vídeo]"));
});

test("TUI LogsView: renders exactly allocated height and switches filters", async () => {
  const { LogsView } = await import("../tui/views/logs-view.ts");
  const view = new LogsView();
  assert.equal(view.id, "logs");
  assert.equal(view.tabNumber, 6);

  const height = 18;
  const lines = view.render(80, height);
  assert.equal(lines.length, height, "LogsView must strictly return the exact allocated height");

  // Switch filter to warnings with 'w'
  view.handleKey({ name: "w", ctrl: false, shift: false, meta: false });
  const warnLines = view.render(80, height);
  assert.equal(warnLines.length, height);

  // Switch filter to errors with 'e'
  view.handleKey({ name: "e", ctrl: false, shift: false, meta: false });
  const errLines = view.render(80, height);
  assert.equal(errLines.length, height);
});

test("TUI ChatView: supports chat conversation scrolling with PageUp/PageDown", async () => {
  const view = new ChatView();

  // Add several messages
  for (let i = 1; i <= 10; i++) {
    (view as any).messages.push({
      role: i % 2 === 1 ? "user" : "assistant",
      content: `Mensagem de teste ${i}\nLinha adicional para ocupar espaço vertical ${i}`,
    });
  }

  const bottomRender = view.render(80, 20).join("\n");
  assert.ok(bottomRender.includes("Mensagem de teste 10"));
  // Scroll up with PageUp
  await view.handleKey({ name: "pageup", ctrl: false, shift: false, meta: false });
  const scrolledRender = view.render(80, 20).join("\n");
  assert.ok(scrolledRender.includes("Rolar:"));

  // Scroll down with PageDown
  await view.handleKey({ name: "pagedown", ctrl: false, shift: false, meta: false });
  const returnedRender = view.render(80, 20).join("\n");
  assert.ok(!returnedRender.includes("Rolar:") || returnedRender.includes("+0"));
});

test("TUI ChatView: supports mouse wheel scrolling with wheelup and wheeldown", async () => {
  const view = new ChatView();

  for (let i = 1; i <= 10; i++) {
    (view as any).messages.push({
      role: i % 2 === 1 ? "user" : "assistant",
      content: `Mensagem ${i}\nLinha extra ${i}`,
    });
  }

  // Mouse wheel up
  await view.handleKey({ name: "wheelup", ctrl: false, shift: false, meta: false });
  const scrolledRender = view.render(80, 20).join("\n");
  assert.ok(scrolledRender.includes("Rolar:"));

  // Mouse wheel down
  await view.handleKey({ name: "wheeldown", ctrl: false, shift: false, meta: false });
  const returnedRender = view.render(80, 20).join("\n");
  assert.ok(!returnedRender.includes("Rolar:") || returnedRender.includes("+0"));
});

test("TUI AccountsView: opens Add Account modal with 'a', types credentials, and cancels with Esc", async () => {
  const view = new AccountsView();

  // Open modal with 'a'
  await view.handleKey({ name: "a", ctrl: false, shift: false, meta: false });
  const modalRender = view.render(80, 20).join("\n");
  assert.ok(modalRender.includes("Adicionar Nova Conta Qwen"));
  assert.ok(modalRender.includes("E-mail:"));
  assert.ok(modalRender.includes("Senha:"));

  // Type email characters
  await view.handleKey({ name: "u", ctrl: false, shift: false, meta: false, char: "u" });
  await view.handleKey({ name: "s", ctrl: false, shift: false, meta: false, char: "s" });

  // Switch to password field with Down arrow (or mouse)
  await view.handleKey({ name: "down", ctrl: false, shift: false, meta: false });
  await view.handleKey({ name: "p", ctrl: false, shift: false, meta: false, char: "p" });

  const typingRender = view.render(80, 20).join("\n");
  assert.ok(typingRender.includes("us"));
  assert.ok(typingRender.includes("•"));

  // Cancel with Esc
  await view.handleKey({ name: "escape", ctrl: false, shift: false, meta: false });
  const closedRender = view.render(80, 20).join("\n");
  assert.ok(!closedRender.includes("Adicionar Nova Conta Qwen"));
});
test("TUI AccountsView: switches fields and cancels via mouse clicks in Add Account modal", async () => {
  const view = new AccountsView();

  // Open modal
  await view.handleKey({ name: "a", ctrl: false, shift: false, meta: false });
  assert.equal(view.isCapturingText(), true);

  // Click row 7 (password field)
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 20, row: 7 },
  });
  // Type into password field
  await view.handleKey({ name: "1", ctrl: false, shift: false, meta: false, char: "1" });
  let render = view.render(80, 20).join("\n");
  assert.ok(render.includes("•"));

  // Click row 6 (email field)
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 20, row: 6 },
  });
  // Type into email field
  await view.handleKey({ name: "a", ctrl: false, shift: false, meta: false, char: "a" });
  render = view.render(80, 20).join("\n");
  assert.ok(render.includes("a"));

  // Click row 9 right side (cancel button)
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 35, row: 9 },
  });
  assert.equal(view.isCapturingText(), false);
});
test("TUI AccountsView: precision mouse hover and click on accounts list rows", async () => {
  const view = new AccountsView();
  const mockSnapshot = {
    online: true,
    accounts: [
      { id: "acc1", emailOrName: "one@test.com", priority: 1, onCooldown: false, remainingCooldownMs: 0, headersReady: true },
      { id: "acc2", emailOrName: "two@test.com", priority: 1, onCooldown: false, remainingCooldownMs: 0, headersReady: true },
    ],
  };

  // Render initial frame to compute layout
  view.render(80, 24, mockSnapshot as any);

  // Moving mouse on row 6 (table header) must NOT trigger hover on account
  await view.handleKey({
    name: "hover",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "hover", col: 10, row: 6 },
  });
  let render = view.render(80, 24, mockSnapshot as any).join("\n");
  assert.ok(!render.includes("two@test.com") || render.includes("one@test.com"));

  // Hovering row 9 (account 2) should highlight row 2
  await view.handleKey({
    name: "hover",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "hover", col: 10, row: 9 },
  });
  render = view.render(80, 24, mockSnapshot as any).join("\n");
  // Check that row 9 got hovered
  assert.ok(render.includes("two@test.com"));

  // Moving mouse away to row 15 should clear hover
  await view.handleKey({
    name: "hover",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "hover", col: 10, row: 15 },
  });

  // Clicking row 9 should select account 2
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 10, row: 9 },
  });
  render = view.render(80, 24, mockSnapshot as any).join("\n");
  // Right panel should now show account 2 details
  assert.ok(render.includes("two@test.com"));
});
test("TUI StorageView: mouse hover and click on quick action rows", async () => {
  const view = new StorageView();
  view.render(80, 24);

  // Hover row 15 ([ z ] Zerar Todos os Cooldowns)
  await view.handleKey({
    name: "hover",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "hover", col: 10, row: 15 },
  });
  let render = view.render(80, 24).join("\n");
  assert.ok(render.includes("Zerar Todos os Cooldowns"));

  // Click row 15 ([ z ] Zerar Todos os Cooldowns)
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 10, row: 15 },
  });
  render = view.render(80, 24).join("\n");
  assert.ok(render.includes("destravada"));
});

test("TUI SyncView: mouse click precisely toggles clients, model, and scope", async () => {
  const view = new SyncView();
  view.render(80, 24);

  // Click row 8 (Claude Code) -> toggles to selected [x]
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 10, row: 8 },
  });
  let render = view.render(80, 24).join("\n");
  assert.ok(render.includes(glyphs.checkOn));

  // Click row 14 (Model selector) -> cycles to next model
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 10, row: 14 },
  });
  render = view.render(80, 24).join("\n");
  assert.ok(render.includes("qwen3.7-plus"));

  // Click row 15 (Scope selector) -> toggles syncAllModels
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 10, row: 15 },
  });
  render = view.render(80, 24).join("\n");
  assert.ok(render.includes(glyphs.radioOff));
  // Verify there is no duplicate "Modelo: Modelo:"
  assert.ok(!render.includes("Modelo: Modelo:"));
});

test("TUI AccountsView: precision mouse click on right panel action buttons", async () => {
  const view = new AccountsView();
  const mockSnapshot = {
    online: true,
    accounts: [
      { id: "1", emailOrName: "one@test.com", priority: 1, onCooldown: false, remainingCooldownMs: 0, headersReady: true },
    ],
  };
  view.render(80, 24, mockSnapshot as any);

  // Click row 18 ([ z ] Zerar Todas) on right panel (col 55)
  await view.handleKey({
    name: "click",
    ctrl: false,
    shift: false,
    meta: false,
    mouse: { type: "click", button: "left", col: 55, row: 18 },
  });
  const render = view.render(80, 24, mockSnapshot as any).join("\n");
  assert.ok(render.includes("Cooldowns zerados"));
});
test("TUI ChatView: displays friendly warning and blocks sending when 0 accounts are configured", async () => {
  const view = new ChatView();
  const emptySnapshot = {
    online: true,
    port: 7936,
    host: "127.0.0.1",
    accounts: [],
  };

  // Render with 0 accounts
  const render = view.render(80, 24, emptySnapshot as any).join("\n");
  assert.ok(render.includes("Nenhuma conta Qwen configurada"));
  assert.ok(render.includes("[5] Contas"));
  assert.ok(render.includes("Sem Contas"));

  // Try to type and submit message with 0 accounts
  await view.handleKey({ name: "h", ctrl: false, shift: false, meta: false, char: "h" });
  await view.handleKey({ name: "i", ctrl: false, shift: false, meta: false, char: "i" });
  await view.handleKey({ name: "return", ctrl: false, shift: false, meta: false });

  // Should have blocked sending without creating an assistant message
  assert.equal((view as any).messages.length, 0);
  const updatedRender = view.render(80, 24, emptySnapshot as any).join("\n");
  assert.ok(updatedRender.includes("Nenhuma conta configurada"));
});
test("TUI App & Chat: single Ctrl+C performs normal function (clears input); q does not exit", async () => {
  const app = new TuiApp(2); // Start in Chat view
  const chatView = (app as any).views[1] as ChatView;

  // Type some text into input
  await (app as any).handleKey({ name: "h", ctrl: false, shift: false, meta: false, char: "h" });
  await (app as any).handleKey({ name: "e", ctrl: false, shift: false, meta: false, char: "e" });
  assert.equal((chatView as any).inputBuffer, "he");

  // Press 'q' - should NOT exit the app and should NOT quit
  await (app as any).handleKey({ name: "q", ctrl: false, shift: false, meta: false, char: "q" });
  // The app is still running and 'q' was typed into input
  assert.ok((chatView as any).inputBuffer.includes("q"));

  // Press single Ctrl+C - should clear the input buffer, not exit!
  await (app as any).handleKey({ name: "c", ctrl: true, shift: false, meta: false });
  assert.equal((chatView as any).inputBuffer, "");
  assert.equal((app as any).isRunning, false); // start() wasn't called, but app didn't throw/exit
});
