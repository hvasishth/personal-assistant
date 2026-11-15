// Minimal leveled logger.
//
// Every log call names a level. A message is printed only when its level is at
// or below the configured threshold, so a single knob (ADVISOR_LOG_LEVEL)
// controls how chatty the process is. "trace" is the very-verbose level — raw
// wire dumps and the like; "info" is the sensible default.
//
// Levels, least to most verbose:
//   silent  nothing at all
//   error   something broke
//   warn    surprising but handled
//   info    normal lifecycle (server started, request handled)
//   debug   developer detail
//   trace   firehose (every SSE block, every frame sent)

export const LOG_LEVELS = [
  "silent",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

// Higher rank = more verbose. A message at `level` prints when
// rank(level) <= rank(threshold). "silent" is the floor and is never emitted at.
const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

// Module-level threshold. Defaults so logging works before setLogLevel runs
// (e.g. a config error logged during startup).
let threshold: LogLevel = "info";

// Set once at startup from config. Safe to call again (tests, reconfig).
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

// Narrow an arbitrary string to a LogLevel — used when validating config.
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function emit(level: Exclude<LogLevel, "silent">, args: unknown[]): void {
  if (RANK[level] > RANK[threshold]) return;
  const prefix = `${new Date().toISOString()} [${level}]`;
  if (level === "error") console.error(prefix, ...args);
  else if (level === "warn") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

export const log = {
  error: (...args: unknown[]): void => emit("error", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  info: (...args: unknown[]): void => emit("info", args),
  debug: (...args: unknown[]): void => emit("debug", args),
  trace: (...args: unknown[]): void => emit("trace", args),
};
