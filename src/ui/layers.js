// One layer per ghost on screen (ssp-ui.md §3.5, §9.1): a 0×0 fixed <div class="smk-ghost" data-ghost="<id>"> in the
// runtime's shadow root that holds that ghost's characters (Stage `root`), balloons and boxes. A positioned element
// with a z-index is a stacking context, so the z-indexes inside it (characters Z_BASE + scope order, balloons + 100,
// boxes + 200) stay local to the ghost, and the ghosts stack as groups at Z_BASE + rank, ranked by activation
// (0 = bottom): the ghost pressed, dragged or raised last is above the others with its balloons and boxes, as SSP's
// owned windows are [infer]. Root-level UI stays above every layer (the launcher dock Z_BASE + 190, menus and the info
// window + 200) and the fill_desktop flash below them (Z_BASE − 1). Without a root (headless) the order is kept by key
// alone. The site decides who is keyboard-active; this module only stacks.
import { getRoot, Z_BASE } from './root.js';

/** the layer element's class: the event loop's pointer test tells its own layer from another ghost's by it */
export const LAYER_CLASS = 'smk-ghost';
/** ranks above this share the top z-index, so no layer reaches the launcher dock (Z_BASE + 190) */
const MAX_RANK = 189;

export class GhostLayers {
  /**
   * @param {{root?: Element|ShadowRoot|null}} [o] where the layers go; default: the runtime's shadow root (getRoot(),
   *   asked at the first create) when a document exists; null: headless (keys and order only, create() returns null)
   */
  constructor({ root } = {}) {
    this._root = root;
    /** @type {any[]} keys, bottom -> top */
    this._keys = [];
    this._els = new Map();
    this._ghosts = new Map();
    this._raising = false;
    /** (key) => void: a layer was raised (a press inside it, or raise()); not called again from inside itself */
    this.onRaise = null;
  }

  /** the element layers are appended to, or null when headless */
  _container() {
    if (this._root === undefined) this._root = typeof document !== 'undefined' ? getRoot() : null;
    return this._root || null;
  }

  /**
   * A layer for `key` (e.g. a Runtime's sid), on top of the others, labelled with its ghost's id. An existing key
   * keeps its element and comes to the top. Returns the element (null when headless).
   * @param {any} key
   * @param {{ghost?: string}} [o]
   * @returns {Element|null}
   */
  create(key, { ghost = '' } = {}) {
    if (this._keys.includes(key)) {
      if (ghost) this.setGhost(key, ghost);
      this._toTop(key);
      return this._els.get(key) || null;
    }
    this._keys.push(key);
    this._ghosts.set(key, String(ghost ?? ''));
    const container = this._container();
    let el = null;
    if (container) {
      el = document.createElement('div');
      el.className = LAYER_CLASS;
      el.dataset.ghost = String(ghost ?? '');
      const s = el.style;
      s.position = 'fixed';
      s.left = '0';
      s.top = '0';
      s.width = '0';
      s.height = '0';
      s.overflow = 'visible';
      // a press anywhere in the ghost (character, balloon, box) raises it first, a drag of an inactive ghost included
      el.addEventListener('pointerdown', () => this.raise(key), { capture: true, passive: true });
      container.appendChild(el);
      this._els.set(key, el);
    }
    this._apply();
    return el;
  }

  /**
   * Bring `key`'s layer above the others and tell onRaise (also when it already was on top). False for an unknown key.
   * @returns {boolean}
   */
  raise(key) {
    if (!this._keys.includes(key)) return false;
    this._toTop(key);
    if (typeof this.onRaise === 'function' && !this._raising) {
      this._raising = true;
      try { this.onRaise(key); } finally { this._raising = false; }
    }
    return true;
  }

  /** Drop `key`'s layer (its element leaves the DOM with whatever is still in it); the others close ranks. */
  remove(key) {
    const i = this._keys.indexOf(key);
    if (i < 0) return false;
    this._keys.splice(i, 1);
    this._ghosts.delete(key);
    const el = this._els.get(key);
    this._els.delete(key);
    if (el) {
      if (typeof el.remove === 'function') el.remove();
      else if (el.parentNode) el.parentNode.removeChild(el);
    }
    this._apply();
    return true;
  }

  /** A ghost change in the slot: the same layer, place and rank, labelled with the new ghost. */
  setGhost(key, ghost) {
    if (!this._keys.includes(key)) return false;
    const g = String(ghost ?? '');
    this._ghosts.set(key, g);
    const el = this._els.get(key);
    if (el) el.dataset.ghost = g;
    return true;
  }

  /** keys, bottom -> top */
  order() { return [...this._keys]; }

  /** the key on top, or null */
  get top() { return this._keys.length ? this._keys[this._keys.length - 1] : null; }

  has(key) { return this._keys.includes(key); }

  /** `key`'s z-index: Z_BASE + its rank (0 = bottom); null for an unknown key */
  zOf(key) {
    const i = this._keys.indexOf(key);
    return i < 0 ? null : Z_BASE + Math.min(i, MAX_RANK);
  }

  /** `key`'s layer element (null when headless or unknown) */
  element(key) { return this._els.get(key) || null; }

  /** `key`'s ghost id label */
  ghostOf(key) { return this._ghosts.has(key) ? this._ghosts.get(key) : null; }

  /** every layer removed */
  destroy() {
    for (const key of [...this._keys]) this.remove(key);
    this.onRaise = null;
  }

  _toTop(key) {
    const i = this._keys.indexOf(key);
    if (i < 0 || i === this._keys.length - 1) return;
    this._keys.splice(i, 1);
    this._keys.push(key);
    this._apply();
  }

  _apply() {
    for (const key of this._keys) {
      const el = this._els.get(key);
      if (el) el.style.zIndex = String(this.zOf(key));
    }
  }
}
