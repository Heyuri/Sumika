// Logging with levels. Ghost data problems are warnings, never exceptions.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let level = LEVELS.warn;
const seen = new Set();

try {
  if (typeof location !== 'undefined' && /[?&]sumika-debug\b/.test(location.search)) level = LEVELS.debug;
} catch (e) { /* not in a page */ }

const out = (lvl, fn, args) => { if (LEVELS[lvl] >= level) fn.call(console, '[sumika]', ...args); };

export const log = {
  debug: (...a) => out('debug', console.debug, a),
  info: (...a) => out('info', console.info, a),
  warn: (...a) => out('warn', console.warn, a),
  error: (...a) => out('error', console.error, a),
  /** warn only the first time a key is seen */
  once(key, ...a) {
    if (seen.has(key)) return;
    seen.add(key);
    out('warn', console.warn, a.length ? a : [key]);
  },
};

export function setLogLevel(name) {
  if (name in LEVELS) level = LEVELS[name];
}
