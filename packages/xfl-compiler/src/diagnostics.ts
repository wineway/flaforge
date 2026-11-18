import type { Diagnostic } from "@flaforge/ir";

export class DiagnosticSink {
  readonly diagnostics: Diagnostic[] = [];
  private readonly seen = new Set<string>();

  add(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  info(code: string, message: string, path?: string, detail?: Record<string, unknown>): void {
    this.add({ level: "info", code, message, ...(path ? { path } : {}), ...(detail ? { detail } : {}) });
  }

  warn(code: string, message: string, path?: string, detail?: Record<string, unknown>): void {
    this.add({ level: "warn", code, message, ...(path ? { path } : {}), ...(detail ? { detail } : {}) });
  }

  error(code: string, message: string, path?: string, detail?: Record<string, unknown>): void {
    this.add({ level: "error", code, message, ...(path ? { path } : {}), ...(detail ? { detail } : {}) });
  }

  /** Emit a diagnostic only once per code + path key. */
  once(level: "info" | "warn" | "error", code: string, message: string, path?: string, detail?: Record<string, unknown>): void {
    const key = `${level}|${code}|${path ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.add({ level, code, message, ...(path ? { path } : {}), ...(detail ? { detail } : {}) });
  }

  warnOnce(code: string, message: string, path?: string, detail?: Record<string, unknown>): void {
    this.once("warn", code, message, path, detail);
  }

  infoOnce(code: string, message: string, path?: string, detail?: Record<string, unknown>): void {
    this.once("info", code, message, path, detail);
  }

  countLevel(level: Diagnostic["level"]): number {
    return this.diagnostics.filter((d) => d.level === level).length;
  }
}
