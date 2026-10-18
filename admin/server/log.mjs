// The program's error log (CLAUDE.md "The admin tool"): `sumika-admin.log` in the temp root (instance.mjs), for what
// the admin cannot see in the page: an error nothing caught, a job that crashed or failed and a route that answered 500
// internal (app.mjs), with its stack, and what a start found of an earlier one's cut-off job. Never the console: it gets lines only at the start and the stop (a
// console in QuickEdit selection blocks whoever writes to it, and the program would freeze). Kept small: past LOG_MAX
// bytes the file becomes `sumika-admin.log.old` (one older file kept). Writing never throws.
import fs from 'node:fs';
import path from 'node:path';

export const LOG = 'sumika-admin.log';
export const LOG_MAX = 1 << 20;

/** An error as the log writes it: its stack (which names it), else its text. */
export function errorText(e) {
  if (e && typeof e === 'object' && typeof e.stack === 'string' && e.stack) return e.stack;
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

/**
 * The log in a folder.
 * @param {string} root the temp root
 * @returns {{file: string, write: (what: string, detail?: string) => void}} write: one entry, the time first and the
 *   detail's lines indented below it
 */
export function errorLog(root, { maxBytes = LOG_MAX, now = () => new Date() } = {}) {
  const file = path.join(root, LOG);
  return {
    file,
    write(what, detail = '') {
      try {
        let size = 0;
        try { size = fs.statSync(file).size; } catch (e) { size = 0; }
        if (size > maxBytes) {
          try { fs.renameSync(file, `${file}.old`); } catch (e) { /* held: this file grows a little longer */ }
        }
        const body = detail ? `\n${String(detail).replace(/\r?\n$/, '').split(/\r?\n/).map(l => `    ${l}`).join('\n')}` : '';
        fs.appendFileSync(file, `${now().toISOString()} ${what}${body}\n`);
      } catch (e) { /* the log is a help only */ }
    },
  };
}

/**
 * Errors nothing caught go to the log and the program keeps serving: in the compiled program Deno's globalThis
 * 'error' and 'unhandledrejection' events (preventDefault keeps it running [measured, Deno 2.9.7]), under
 * Node process's 'uncaughtException' and 'unhandledRejection'.
 * @param {{write: Function}} log errorLog's
 */
export function catchStray(log, { deno = globalThis.Deno, proc = process, target = globalThis } = {}) {
  if (deno && typeof target.addEventListener === 'function') {
    target.addEventListener('error', e => {
      e.preventDefault();
      log.write('an error nothing caught', errorText(e.error ?? e.message));
    });
    target.addEventListener('unhandledrejection', e => {
      e.preventDefault();
      log.write('a rejection nothing handled', errorText(e.reason));
    });
    return;
  }
  proc.on('uncaughtException', e => log.write('an error nothing caught', errorText(e)));
  proc.on('unhandledRejection', e => log.write('a rejection nothing handled', errorText(e)));
}
