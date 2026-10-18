// Engine names the worker can run: the keys of ENGINES in ./index.js (a test keeps the two equal). Kept apart so the
// page bundle can ask without pulling the engines in: the menu lists other ghosts disabled, and a switch to one is
// refused before the running ghost is unloaded (EV §2.5).

export const SUPPORTED_ENGINES = Object.freeze(['satori', 'yaya', 'kawari', 'kawari7']);

/**
 * Display names for engines a ghost may need (the index 'engine' field: the SHIORI DLL's lower-cased base name, or the
 * indexer's family name: 'yaya', and 'kawari' / 'kawari7' by the ghost's kawarirc.kis or kawari.ini). 'kawari7' is a
 * Phase 7 ghost (kawari.ini, SHIORI/2.x), run by the Kawari 7.5.0 build (kawari7-wasm.md).
 * kawarirc and kawari8: DLL stems an index written before the Kawari rule (index_site.py
 * kawari_phase) may still hold.
 */
const ENGINE_LABELS = {
  yaya: 'YAYA', aya: 'AYA', aya5: 'AYA', kawari: 'Kawari', kawari7: 'Kawari 7', kawarirc: 'Kawari', kawari8: 'Kawari',
  misaka: 'Misaka', satori: 'Satori',
};

/** @param {{engine?: string}|string|null} g an index entry (or an engine name); a missing name means Satori */
export function engineSupported(g) {
  const name = typeof g === 'string' ? g : g && g.engine;
  return SUPPORTED_ENGINES.includes(String(name || 'satori').toLowerCase());
}

/** The engine a ghost needs and the runtime lacks, by its display name ('YAYA'), or null when it can run. */
export function engineNeeds(g) {
  if (engineSupported(g)) return null;
  const name = String((g && g.engine) || '').toLowerCase();
  return ENGINE_LABELS[name] || (g && g.shiori) || `${name}.dll`;
}

/** Short reason a ghost cannot run here ('needs Kawari'), or null when it can (logs, the page API; the menu words it
 *  in the UI language from engineNeeds). */
export function engineNote(g) {
  const needs = engineNeeds(g);
  return needs ? `needs ${needs}` : null;
}
