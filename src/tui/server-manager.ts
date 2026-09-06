/**
 * QwenProxy TUI - In-Process Server Manager ("Tudo Junto Uma Coisa Só")
 * Starts and manages the Hono + Playwright proxy server directly within the TUI process.
 */

import { config } from "../core/config.ts";
import { startServer, stopServer } from "../api/server.ts";
import { stripAnsi } from "./theme.ts";
export type ServerLifecycleState = "offline" | "warming" | "online" | "error";

export interface ServerLogEntry {
  time: string;
  level: "INFO" | "WARN" | "ERROR";
  message: string;
}

export class ServerManager {
  private static instance: ServerManager | null = null;

  private state: ServerLifecycleState = "offline";
  private lastError: string | null = null;
  private logEntries: ServerLogEntry[] = [];
  private logBuffer: string[] = [];
  private originalLog = console.log;
  private originalInfo = console.info;
  private originalDebug = console.debug;
  private originalWarn = console.warn;
  private originalError = console.error;
  private originalStdoutWrite = process.stdout.write.bind(process.stdout);
  private originalStderrWrite = process.stderr.write.bind(process.stderr);
  private intercepted = false;
  private isTuiRendering = false;
  private startPromise: Promise<void> | null = null;

  public static getInstance(): ServerManager {
    if (!ServerManager.instance) {
      ServerManager.instance = new ServerManager();
    }
    return ServerManager.instance;
  }

  public getState(): ServerLifecycleState {
    return this.state;
  }

  public withTuiRendering<T>(fn: () => T): T {
    this.isTuiRendering = true;
    try {
      return fn();
    } finally {
      this.isTuiRendering = false;
    }
  }

  public getRawStdoutWrite(): (chunk: string | Uint8Array) => boolean {
    return this.originalStdoutWrite;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getRecentLogs(max = 12): string[] {
    return this.logBuffer.slice(-max);
  }

  public getLogEntries(filter: "all" | "warn" | "error" = "all"): ServerLogEntry[] {
    if (filter === "error") {
      return this.logEntries.filter((e) => e.level === "ERROR");
    }
    if (filter === "warn") {
      return this.logEntries.filter((e) => e.level === "WARN" || e.level === "ERROR");
    }
    return this.logEntries;
  }

  public clearLogs(): void {
    this.logEntries = [];
    this.logBuffer = [];
  }

  private appendLog(level: "INFO" | "WARN" | "ERROR", text: string): void {
    if (!text) return;
    const clean = stripAnsi(text).trim();
    if (!clean || clean.length === 0) return;

    const time = new Date().toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const lines = clean.split(/\r?\n/);
    for (const raw of lines) {
      let line = raw.trim();
      if (!line) continue;

      // Filter out raw ASCII box frames (like +-----+ or empty row | |)
      if (/^[+\-=#]{5,}$/.test(line)) continue;
      if (/^\|\s*\|$/.test(line)) continue;

      // If line is an ASCII box row like "|  Endpoint   http://...  |", extract the text
      if (line.startsWith("|") && line.endsWith("|")) {
        line = line.slice(1, -1).trim();
      }

      if (!line) continue;

      // Prevent identical consecutive duplicate logs in the same second
      const last = this.logEntries[this.logEntries.length - 1];
      if (last && last.time === time && last.level === level && last.message === line) {
        continue;
      }

      this.logEntries.push({ time, level, message: line });
      if (this.logEntries.length > 500) {
        this.logEntries.shift();
      }

      const levelTag = level === "ERROR" ? "[ERR]" : level === "WARN" ? "[WARN]" : "";
      const formatted = `[${time}] ${levelTag ? levelTag + " " : ""}${line}`;
      this.logBuffer.push(formatted);
      if (this.logBuffer.length > 500) {
        this.logBuffer.shift();
      }
    }
  }

  public interceptLogs(): void {
    if (this.intercepted) return;
    this.intercepted = true;

    console.log = (...args: any[]) => {
      this.appendLog(
        "INFO",
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      );
    };

    console.info = (...args: any[]) => {
      this.appendLog(
        "INFO",
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      );
    };

    console.debug = (...args: any[]) => {
      this.appendLog(
        "INFO",
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      );
    };

    console.warn = (...args: any[]) => {
      this.appendLog(
        "WARN",
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      );
    };

    console.error = (...args: any[]) => {
      this.appendLog(
        "ERROR",
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      );
    };

    // Sandbox direct process.stdout.write calls (Playwright, Hono, etc.)
    process.stdout.write = ((chunk: any, encoding?: any, cb?: any) => {
      if (this.isTuiRendering) {
        return this.originalStdoutWrite(chunk, encoding, cb);
      }
      const str = typeof chunk === "string" ? chunk : chunk?.toString(encoding);
      this.appendLog("INFO", str);
      if (typeof cb === "function") cb();
      return true;
    }) as any;

    // Sandbox direct process.stderr.write calls
    process.stderr.write = ((chunk: any, encoding?: any, cb?: any) => {
      const str = typeof chunk === "string" ? chunk : chunk?.toString(encoding);
      this.appendLog("ERROR", str);
      if (typeof cb === "function") cb();
      return true;
    }) as any;
  }

  public restoreLogs(): void {
    if (!this.intercepted) return;
    console.log = this.originalLog;
    console.info = this.originalInfo;
    console.debug = this.originalDebug;
    console.warn = this.originalWarn;
    console.error = this.originalError;
    process.stdout.write = this.originalStdoutWrite;
    process.stderr.write = this.originalStderrWrite;
    this.intercepted = false;
  }

  /**
   * Checks if proxy is already running on port 7936, or boots it up in-process.
   */
  public async ensureStarted(): Promise<void> {
    if (this.state === "online") return;
    if (this.startPromise) return this.startPromise;

    const port = config.server?.port || 7936;
    const host = config.server?.host || "127.0.0.1";
    const cleanHost = host === "0.0.0.0" ? "127.0.0.1" : host;

    // 1. Probe if already online
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 600);
      const resp = await fetch(`http://${cleanHost}:${port}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        this.state = "online";
        this.appendLog(
          "INFO",
          `QwenProxy já está em execução na porta ${port}. Conectado com sucesso!`,
        );
        return;
      }
    } catch {}

    // 2. Start in-process
    this.state = "warming";
    this.appendLog(
      "INFO",
      `Iniciando servidor QwenProxy na porta ${port} e aquecendo Playwright...`,
    );

    this.interceptLogs();

    this.startPromise = (async () => {
      try {
        await startServer({ installSignalHandlers: false });
        this.state = "online";
        this.appendLog(
          "INFO",
          `✓ Servidor QwenProxy pronto e online em http://${cleanHost}:${port}/v1`,
        );
      } catch (err: any) {
        this.state = "error";
        this.lastError = err?.message || String(err);
        this.appendLog(
          "ERROR",
          `✗ Falha ao iniciar servidor: ${this.lastError}`,
        );
      } finally {
        this.startPromise = null;
      }
    })();
  }

  public async stop(): Promise<void> {
    this.restoreLogs();
    try {
      await stopServer();
      this.state = "offline";
    } catch {}
  }
}
