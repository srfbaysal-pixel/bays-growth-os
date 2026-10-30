type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min: Level = (process.env.LOG_LEVEL as Level) || (process.env.NODE_ENV === 'test' ? 'warn' : 'info');

const SECRET_KEYS = /pass|secret|token|key|authorization|cookie/i;
function redact(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v);
  return out;
}

export const log = {
  log(level: Level, msg: string, meta?: Record<string, unknown>) {
    if (order[level] < order[min]) return;
    const line = { t: new Date().toISOString(), level, msg, ...(meta ? (redact(meta) as object) : {}) };
    (level === 'error' ? console.error : console.log)(JSON.stringify(line));
  },
  debug: (m: string, meta?: Record<string, unknown>) => log.log('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log.log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log.log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log.log('error', m, meta)
};
