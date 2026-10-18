// The site index's files as the runtime finds them (src/core/loader.js SiteIndex): ghosts.json `manifests` names each
// manifest (format 2: a hash of its bytes in its name, safe updates); a format 1 index has the fixed names
// ghost.<id>.json / balloon.<id>.json. For the tests that read a site's manifests from disk.
import fs from 'node:fs';
import path from 'node:path';

/** SITE/sumika/index/ghosts.json, parsed. */
export function siteIndexOf(siteDir) {
  return JSON.parse(fs.readFileSync(path.join(siteDir, 'sumika', 'index', 'ghosts.json'), 'utf8'));
}

/**
 * The manifest file of a ghost or balloon: its path on disk, as ghosts.json names it (format 1: the fixed name).
 * @param {string} siteDir  @param {'ghost'|'balloon'} kind  @param {string} id
 * @param {object} [index] ghosts.json, when already read
 */
export function manifestFile(siteDir, kind, id, index = siteIndexOf(siteDir)) {
  const named = index.manifests && index.manifests[kind] && index.manifests[kind][id];
  const rel = named || `sumika/index/${kind}.${id}.json`;
  return path.join(siteDir, ...rel.split('/'));
}

/** A ghost's or balloon's manifest, parsed (manifestFile). */
export function manifestOf(siteDir, kind, id, index) {
  return JSON.parse(fs.readFileSync(manifestFile(siteDir, kind, id, index), 'utf8'));
}
