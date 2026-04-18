import { inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): LogLevel {
  const raw = (process.env.SYMPHONY_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

function formatFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let rendered: string;
    if (v === null) rendered = "null";
    else if (typeof v === "string") rendered = v.includes(" ") || v.includes("=") ? JSON.stringify(v) : v;
    else if (typeof v === "number" || typeof v === "boolean") rendered = String(v);
    else rendered = JSON.stringify(v, safeReplacer);
    parts.push(`${k}=${rendered}`);
  }
  return parts.join(" ");
}

function safeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function emit(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const ts = new Date().toISOString();
  const rendered = formatFields(fields);
  const line = rendered ? `${ts} ${level} ${msg} ${rendered}` : `${ts} ${level} ${msg}`;
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export type Logger = {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): Logger;
};

export function createLogger(context: Record<string, unknown> = {}): Logger {
  const merged = { ...context };
  return {
    debug(msg, fields = {}) {
      emit("debug", msg, { ...merged, ...fields });
    },
    info(msg, fields = {}) {
      emit("info", msg, { ...merged, ...fields });
    },
    warn(msg, fields = {}) {
      emit("warn", msg, { ...merged, ...fields });
    },
    error(msg, fields = {}) {
      emit("error", msg, { ...merged, ...fields });
    },
    child(extra) {
      return createLogger({ ...merged, ...extra });
    },
  };
}

export function describe(value: unknown): string {
  return inspect(value, { depth: 3, breakLength: 120 });
}

export const rootLogger = createLogger({ component: "symphony" });
