// Progress of the long jobs (extract, compare, copy, index, remove) for the admin program: onProgress({phase, done,
// total, item}) at a modest rate (the first and last step of a phase always, else at most every PROGRESS_MS), never
// output of the core's own (the CLI prints only the `log` lines it is given).

export const PROGRESS_MS = 100;

/**
 * @param {((p: {phase: string, done: number, total: number|null, item: string|null}) => void)|null|undefined} onProgress
 * @returns {(phase: string, done: number, total: number|null, item?: string|null) => void}
 */
export function progress(onProgress) {
  if (typeof onProgress !== 'function') return () => {};
  let last = 0, lastPhase = null;
  return (phase, done, total, item = null) => {
    const now = Date.now();
    const edge = phase !== lastPhase || done === 0 || (total !== null && done >= total);
    if (!edge && now - last < PROGRESS_MS) return;
    last = now;
    lastPhase = phase;
    onProgress({ phase, done, total, item });
  };
}
