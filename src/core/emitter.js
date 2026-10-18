// Minimal event emitter.
export class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { const s = this._handlers.get(type); if (s) s.delete(fn); }
  emit(type, ...args) {
    const s = this._handlers.get(type);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(...args); } catch (e) { console.error('[sumika] handler for', type, e); }
    }
  }
}
