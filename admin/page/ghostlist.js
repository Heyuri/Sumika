// The Ghosts screen's order (CLAUDE.md "The admin tool", Order): Change ghost ▸'s, ssp.exe's ghost order (by descript
// name, ties by folder: src/core/shells.js compareEntries) [observed]. The program sorts /api/ghosts' rows so,
// indexed ones and folders the index lacks alike (admin/server/app.mjs ghostList), as the runtime sorts the index it
// loads (src/core/loader.js SiteIndex.load); the screen shows them as they come and never sorts them. Pure.

/**
 * @param {{id: string, indexed?: boolean}[]} ghosts  /api/ghosts' rows, in Change ghost ▸'s order
 * @returns {object[]} the rows to show, in the same order
 */
export function ghostRows(ghosts) {
  return (Array.isArray(ghosts) ? ghosts : []).filter(g => g && typeof g.id === 'string');
}

/** Display names of the engines ghosts.json names (src/worker/engines/supported.js ENGINE_LABELS; proper names). */
export const ENGINE_NAMES = Object.freeze({ satori: 'Satori', yaya: 'YAYA', kawari: 'Kawari', kawari7: 'Kawari 7' });

/** An engine id as the page shows it. */
export const engineName = id => ENGINE_NAMES[String(id || 'satori').toLowerCase()] || String(id || '');
