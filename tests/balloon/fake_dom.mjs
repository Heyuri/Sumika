// A minimal fake DOM, just enough to run src/balloon/view.js, dialogs.js and ui/menu.js's rows in Node (no browser
// available to tests).
// Canvas contexts record their calls.

function recorderCtx(canvas) {
  const calls = [];
  const state = { globalCompositeOperation: 'source-over', font: '', fillStyle: '', strokeStyle: '', imageSmoothingEnabled: true,
    textBaseline: 'alphabetic', lineWidth: 1 };
  const stack = [];
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'calls') return calls;
      if (k === 'canvas') return canvas;
      if (k === 'save') return () => stack.push({ ...state });
      if (k === 'restore') return () => Object.assign(state, stack.pop());
      if (k === 'measureText') return s => ({ width: [...s].length * 6 });
      // opaque white, or the canvas's own `pixels(x, y)` -> [r, g, b, a] when a test gives it one
      if (k === 'getImageData') {
        return (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4).fill(255);
          if (typeof canvas.pixels === 'function') {
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data.set(canvas.pixels(x + i, y + j), (j * w + i) * 4);
          }
          return { data, width: w, height: h };
        };
      }
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...a) => { calls.push([k, ...a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/** an element's inline style: plain properties, plus custom properties through setProperty / getPropertyValue */
function fakeStyle() {
  const style = {};
  Object.defineProperties(style, {
    setProperty: { value(k, v) { this[k] = String(v); } },
    getPropertyValue: { value(k) { return this[k] ?? ''; } },
    removeProperty: { value(k) { delete this[k]; } },
  });
  return style;
}

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  toggle(c, on) { if (on === undefined ? !this.set.has(c) : on) this.set.add(c); else this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

export class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.style = fakeStyle();
    this.dataset = {};
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.className = '';
    this.classList = new ClassList(this);
    this.parent = null;
    this.width = 300;
    this.height = 150;
    this.value = '';
    this.textContent = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...els) { for (const e of els) this.appendChild(e); }
  appendChild(e) { e.parent = this; this.children.push(e); return e; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  contains(e) { for (let x = e; x; x = x.parent) if (x === this) return true; return false; }
  getRootNode() { let x = this; while (x.parent) x = x.parent; return x; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
  /** Fire an event at this element; returns the event object. */
  fire(type, init = {}) {
    const ev = { type, defaultPrevented: false, propagationStopped: false, button: 0, clientX: 0, clientY: 0, key: '', keyCode: 0, isComposing: false,
      stopPropagation() { this.propagationStopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  getContext() { return (this._ctx ||= recorderCtx(this)); }
  /** left/top offsets up the tree, and CSS `scale(k)` transforms with transform-origin 0 0 (balloon scaling) */
  getBoundingClientRect() {
    const chain = [];
    for (let x = this; x; x = x.parent) chain.unshift(x);
    let left = 0, top = 0, k = 1;
    for (const x of chain) {
      left += (parseFloat(x.style.left) || 0) * k;
      top += (parseFloat(x.style.top) || 0) * k;
      const m = /scale\(\s*([\d.]+)\s*\)/.exec(x.style.transform || '');
      if (m) k *= parseFloat(m[1]);
    }
    return { left, top, width: (parseFloat(this.style.width) || this.width) * k, height: (parseFloat(this.style.height) || this.height) * k };
  }
  attachShadow() { const r = new FakeEl('#shadow-root'); r.host = this; this.shadowRoot = r; return r; }
  getElementById(id) {
    for (const c of this.children) { if (c.id === id) return c; const f = c.getElementById(id); if (f) return f; }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const walk = el => { for (const c of el.children) { if (cls ? c.className.split(/\s+/).includes(cls) : c.tagName === sel.toUpperCase()) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  focus() { globalThis.document.activeElement = this; }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  select() {}
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture(id) { if (this.captured === id) this.captured = undefined; }
  get isContentEditable() { return false; }
}

/** Install document/window/requestAnimationFrame globals. */
export function installFakeDom() {
  if (globalThis.document && globalThis.document.__fake) return globalThis.document;
  const body = new FakeEl('body');
  const document = {
    __fake: true, body, documentElement: Object.assign(new FakeEl('html'), { clientWidth: 1280, clientHeight: 720 }), activeElement: body,
    createElement: tag => new FakeEl(tag), createTextNode: text => Object.assign(new FakeEl('#text'), { textContent: String(text) }),
    currentScript: null, readyState: 'complete',
  };
  globalThis.document = document;
  globalThis.window = { innerWidth: 1280, innerHeight: 720, visualViewport: null, addEventListener() {}, removeEventListener() {} };
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = id => clearTimeout(id);
  return document;
}

export const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
