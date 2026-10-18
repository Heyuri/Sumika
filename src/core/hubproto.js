// The hub protocol (CONTRACTS "Hub protocol"): what the page side (core/hub.js, core/portstore.js, the worker) and the
// hub (src/hub/) share. The protocol, not the build, is the contract between a page and a hub: a hub answers every
// version in [HUB_MIN, HUB_MAX]; a change an older peer would misread takes a new version, and a hub keeps answering
// the old one while builds speaking it may still be cached (prune's 14 days plus the hosts' cache).

/** The protocol this page speaks. */
export const HUB_PROTOCOL = 1;
/** The versions this hub answers. */
export const HUB_MIN = 1;
export const HUB_MAX = 1;
/** The query parameter the page adds to the hub URL: its protocol (a newer protocol is a URL no cache has seen). */
export const HUB_PARAM = 'sumika-hub';
/** The window message that opens a connection: {[HELLO]: 1, v, debug?}, with a MessagePort (the private channel). */
export const HELLO = 'sumikaHubHello';
/** What a hub serves: localStorage and sessionStorage keys, the IndexedDB database, lock and channel names. */
export const LOCAL_PREFIX = 'sumika:';
export const SESSION_PREFIX = 'sumika.';
export const STORE_DB = 'sumika';
export const NAME_PREFIX = 'sumika';
/** The cookie of the hub's same-site probe: set and deleted at once. */
export const PROBE_COOKIE = 'sumika-hub-probe';
/** Why a hub refuses a page (the page falls back and logs it once). */
export const REASONS = Object.freeze(['origin', 'allowlist', 'version', 'site', 'storage', 'busy']);
/** A will's stamp: a top-level field the hub sets to its Date.now() when the lock goes. */
export const STAMP = /^[A-Za-z_]\w*$/;
/**
 * A store port's answer to a write once the port is retired: the page marked it `retire` (an engine start's) and the
 * hub's document went into the back/forward cache since (its pagehide, persisted). The page starts its engines again
 * after the restore, with new ports; a write the old engine posts late never lands over what another page stored.
 */
export const RETIRED = 'retired';

export const isLocalKey = k => typeof k === 'string' && k.startsWith(LOCAL_PREFIX);
export const isSessionKey = k => typeof k === 'string' && k.startsWith(SESSION_PREFIX);
export const isName = n => typeof n === 'string' && n.startsWith(NAME_PREFIX);
