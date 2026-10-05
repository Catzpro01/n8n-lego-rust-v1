/**
 * Structured logger. `text` for a human at a terminal, `json` for systemd.
 * Log lines always carry the service name so they can be grepped next to n8n
 * leaks: `journalctl -u n8n-lego | grep n8n-lego`.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', format = 'text', base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, message, fields) {
    if ((LEVELS[levelName] ?? 0) < threshold) return;
    const record = { level: levelName, msg: message, ...base, ...(fields ?? {}) };
    const stream = levelName === 'error' || levelName === 'warn' ? process.stderr : process.stdout;
    if (format === 'json') {
      stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
      return;
    }
    const { level: _level, msg: _msg, service, pid, ...rest } = record;
    const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    stream.write(`${new Date().toISOString()} ${levelName.toUpperCase().padEnd(5)} ${message}${extra}\n`);
  }

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extraBase) => createLogger({ level, format, base: { ...base, ...extraBase } }),
  };
}
