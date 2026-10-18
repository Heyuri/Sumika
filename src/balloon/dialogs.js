// Input box (balloonc3), communicate box (balloonc1) and teach box (balloonc2): BA §5, UI §6, SUM §3.6.
// A real <input> over the keyed balloonc image, so IME, paste, mobile keyboards and screen readers work.
// Boxes are modeless and several can be open at once. Without a DOM (Node tests) boxes exist as state only and can be
// answered with submit()/cancel().
// The communicate box looks and works like SSP's: the field is followed by small "OK" and "×" push buttons, and it
// stays open after each message (Enter / OK) until × or Esc closes it (UI §6.1). The teach box has the same look
// (UKADOC names its OK button) but closes after one word, like an input box (UI §6.3).
// The runtime's own labels (accessible names, tooltips) are in the visitor's UI language (UI §2.10); a title the ghost
// gives a box is shown as it is.
// A balloon change redraws open boxes from the new skin (setSkin); a shell change places them again (setStage) (BA §12).
// Phones only (the `phone` option, UI §9.11): the focused box moves up or down above the on-screen keyboard, a box
// wider than the phone shrinks to it and the field is 16 px; without it (every desktop) none of that runs.
import { Emitter } from '../core/emitter.js';
import { log } from '../core/log.js';
import { t } from '../core/i18n.js';
import { addStyle, getRoot, Z_BASE } from '../ui/root.js';
import { keepVisible, visibleRect, watchVisible, zoomed } from '../ui/viewport.js';
import { BalloonSkin } from './skin.js';
import { placeBox } from './placement.js';
import { cfgColor, css } from './color.js';

const hasDom = () => typeof document !== 'undefined';

const CSS = `
.smk-box{position:absolute;left:0;top:0;pointer-events:auto;user-select:none;-webkit-user-select:none;touch-action:none;}
.smk-box>canvas{position:absolute;left:0;top:0;display:block;cursor:move;}
.smk-box>input{position:absolute;box-sizing:border-box;margin:0;padding:0 2px;border:0;outline:none;border-radius:0;
  user-select:text;-webkit-user-select:text;touch-action:auto;line-height:normal;font-kerning:none;}
.smk-box>input:focus-visible{outline:1px dotted rgba(0,0,0,.4);}
.smk-box>.smk-box-x{position:absolute;top:2px;right:6px;width:16px;height:16px;padding:0;margin:0;border:0;background:transparent;
  font:12px/16px sans-serif;color:rgba(40,60,120,.75);cursor:pointer;}
.smk-box>.smk-box-x:hover{color:rgb(200,40,40);}
.smk-box>.smk-box-btn{position:absolute;box-sizing:border-box;margin:0;padding:0;border:1px solid;border-radius:0;
  background:transparent;font-size:0;overflow:hidden;cursor:default;touch-action:manipulation;}
.smk-box>.smk-box-btn>canvas{position:absolute;display:block;pointer-events:none;}
.smk-box>.smk-box-btn:active{background:rgba(0,0,0,.1);}
.smk-box>.smk-box-btn:focus-visible{outline:1px dotted;outline-offset:-3px;}
.smk-box-communicate>input{border:1px solid;border-color:rgb(236,236,236) rgb(230,230,230) rgb(131,131,131) rgb(236,236,236);
  box-shadow:inset 1px 1px 0 rgb(254,254,254),inset -1px 0 0 rgb(247,247,247),inset 0 -1px 0 rgb(254,254,254);padding:0 2px;}
.smk-box-communicate>input:focus{outline:none;border-bottom-color:rgb(0,103,192);
  box-shadow:inset 1px 1px 0 rgb(254,254,254),inset -1px 0 0 rgb(247,247,247),inset 0 -1px 0 rgb(0,103,192);}
.smk-box.smk-pulse{animation:smk-box-pulse .6s ease-out 2}
@keyframes smk-box-pulse{50%{filter:brightness(1.15) drop-shadow(0 0 4px rgba(80,120,255,.8))}}
`;

// communicate box push buttons (UI §6.1), measured on ssp.exe 2.9.08f [observed]: [field] 1 px gap [OK 20][× 18],
// as tall as the field and filling the communicatebox.* rectangle. SSP draws them itself: transparent, a 1 px frame and
// a bitmap glyph in the balloon's font colour. The field is a Windows 11 text box (light frame, dark bottom line that
// turns accent blue while focused) filled with the image's colour at the centre of communicatebox.*.
const BTN = { ok: 20, close: 18, gap: 1, between: 0, minField: 80 };
// '#' = pen pixel; at = glyph offset from the button's outer top-left
const GLYPHS = {
  ok: { at: [4, 4], rows: ['.###..#..#', '#...#.#..#', '#...#.#.#.', '#...#.#.#.', '#...#.##..', '#...#.#.#.', '#...#.#.#.', '#...#.#..#', '.###..#..#'] },
  close: { at: [5, 5], rows: ['##....##', '###..###', '.######.', '..####..', '..####..', '.######.', '###..###', '##....##'] },
};

/**
 * SSP draws input and communicate boxes at their image's own pixel size: with Windows display scaling at 125 % the
 * balloon and the character grow but these boxes do not [observed, UI §6.1]. Do the same where there is a mouse.
 * Touch screens keep CSS pixels so the box stays big enough to use.
 */
function boxScale(dpr) {
  const fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
  return fine && dpr > 1 ? 1 / dpr : 1;
}

/** A glyph as a canvas inside its button, drawn on whole device pixels so it stays sharp at any devicePixelRatio. */
function glyphCanvas(g, color, dpr) {
  const w = g.rows[0].length, h = g.rows.length;
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  // positioned children of a button start inside its 1 px border
  Object.assign(c.style, { left: g.at[0] - 1 + 'px', top: g.at[1] - 1 + 'px', width: w + 'px', height: h + 'px' });
  const ctx = c.getContext && c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = color;
    const d = v => Math.round(v * dpr);
    g.rows.forEach((row, y) => {
      for (let x = 0; x < w; x++) if (row[x] === '#') ctx.fillRect(d(x), d(y), d(x + 1) - d(x), d(y + 1) - d(y));
    });
  }
  return c;
}

const KINDS = { text: 'text', input: 'text', inputbox: 'text', password: 'password', passwordinput: 'password', date: 'date',
  dateinput: 'date', time: 'time', timeinput: 'time', slider: 'slider', sliderinput: 'slider', ip: 'ip', ipinput: 'ip' };

/** Value reported to SHIORI for a box kind (dateinput: "Y,M,D", timeinput: "h,m,s"). */
export function formatInput(kind, raw) {
  const s = String(raw ?? '');
  let m;
  if (kind === 'date' && (m = /^(\d+)-(\d+)-(\d+)$/.exec(s))) return `${+m[1]},${+m[2]},${+m[3]}`;
  if (kind === 'time' && (m = /^(\d+):(\d+)(?::(\d+))?/.exec(s))) return `${+m[1]},${+m[2]},${+(m[3] || 0)}`;
  return s;
}

/** True while an IME is composing (Enter then confirms the conversion and must not submit). */
export function isComposing(ev) {
  return !!(ev && (ev.isComposing || ev.keyCode === 229));
}

/**
 * @typedef {{text:string|null, timedOut:boolean, reason:'ok'|'cancel'|'timeout'|'closed'}} InputResult
 */

export class Dialogs extends Emitter {
  /**
   * @param {object} [o]
   * @param {BalloonSkin} [o.skin]
   * @param {object} [o.stage]      Stage, for placing a box near its character
   * @param {ShadowRoot|HTMLElement|null} [o.root]  default: the runtime's shadow root; null = headless
   * @param {object} [o.balloons]   Balloons, for placing a box under the scope's balloon
   * @param {object} [o.language]   core/language.js UiLanguage: the language of the runtime's labels (open boxes are
   *   re-labelled when it changes); none: English
   * @param {{short:number, long:number, mobileView:boolean}|null} [o.phone]  phones only (UI §9.11): the keyboard
   *   rules, the 16-px field, and with mobileView a box no wider than the phone; none: the desktop boxes
   */
  constructor(o = {}) {
    super();
    this.skin = o.skin || BalloonSkin.fallback();
    this.stage = o.stage || null;
    this.balloons = o.balloons || null;
    this.root = o.root !== undefined ? o.root : hasDom() ? getRoot() : null;
    this.language = o.language || null;
    this.phone = o.phone || null;
    /** phones: off() of the visual viewport watcher, while a box is open */
    this._offKeys = null;
    /** open boxes, oldest first */
    this.boxes = [];
    /** setStage: boxes waiting for their character's size on the new stage, and the listeners' off ({pending, off}) */
    this._wait = null;
    this._offLang = this.language && typeof this.language.on === 'function'
      ? this.language.on('change', () => { for (const b of this.boxes) if (b.el) this._label(b); })
      : null;
  }

  get lang() { return this.language ? this.language.lang : 'en'; }

  /**
   * \![open,inputbox,ID,timeout,text,...] and its variants.
   * @param {{id:string, scope?:number, title?:string, defaultText?:string, timeoutMs?:number, kind?:string,
   *          limit?:number, balloon?:number, min?:number, max?:number, at?:{x:number,y:number},
   *          inputMode?:string, hint?:string, placeholder?:string, pulse?:boolean,
   *          texts?:(lang:string)=>{title?:string, hint?:string, placeholder?:string}}} o  inputMode, hint,
   *   placeholder: the field's inputmode, tooltip and placeholder; pulse: draw attention to it (the runtime's own boxes:
   *   a retry); texts: the runtime's own box words its title, hint and placeholder in a UI language (they follow a
   *   language change while it is open)
   * @returns {Promise<InputResult>}
   */
  inputBox(o = {}) {
    const id = String(o.id ?? '');
    for (const b of [...this.boxes]) if (b.type === 'input' && b.id === id) this._settle(b, null, 'closed');
    return this._open('input', { ...o, id, kind: KINDS[String(o.kind || 'text').toLowerCase()] || 'text' }).promise;
  }

  /**
   * \![open,communicatebox]. With onSend (SSP behaviour) the box stays open: each Enter or OK with some text calls
   * onSend(text), clears the field and keeps the focus; the promise resolves when the box closes, with null (× / Esc:
   * reason 'cancel'; \![close,communicatebox] or a new box: 'closed'). Without onSend it is one-shot: it resolves with
   * the first text sent. With {detailed:true} it resolves with {text, reason} instead. Empty text is never sent.
   * @param {{scope?:number, defaultText?:string, at?:{x:number,y:number}, detailed?:boolean,
   *          onSend?:(text:string)=>void}} [o]
   */
  communicateBox(o = {}) {
    for (const b of [...this.boxes]) if (b.type === 'communicate') this._settle(b, null, 'closed');
    return this._open('communicate', { ...o, id: 'communicatebox', kind: 'text', balloon: o.balloon ?? 1 }).promise;
  }

  /**
   * \![open,teachbox] / \__t (UI §6.3): the communicate box's look ([field][OK][×]) over balloonc2, one word at a time:
   * Enter or OK with some text resolves {text, reason:'ok'}, × / Esc {text:null, reason:'cancel'}, close('teachbox')
   * or a new teach box {text:null, reason:'closed'} (InputResult). Empty text is never sent.
   * @param {{scope?:number, defaultText?:string, title?:string, balloon?:number, at?:{x:number,y:number}}} [o]
   * @returns {Promise<InputResult>}
   */
  teachBox(o = {}) {
    for (const b of [...this.boxes]) if (b.type === 'teach') this._settle(b, null, 'closed');
    return this._open('teach', { ...o, id: 'teachbox', kind: 'text', balloon: o.balloon ?? 2 }).promise;
  }

  /**
   * Close without any cancel event: an input box by id ('' is an id like any other: a box opened without one),
   * every input box ('__SYSTEM_ALL_INPUT__'), the communicate box ('communicatebox'), the teach box ('teachbox'), or
   * everything (no argument).
   */
  close(id) {
    const all = id === undefined || id === null;
    const key = all ? '' : String(id).toLowerCase();
    for (const b of [...this.boxes]) {
      if (all || (id === '__SYSTEM_ALL_INPUT__' && b.type === 'input') || b.id === String(id) ||
        (b.type === 'communicate' && key === 'communicatebox') || (b.type === 'teach' && key === 'teachbox')) {
        this._settle(b, null, 'closed');
      }
    }
  }

  /** Answer a box as if the user pressed Enter (by id, or the box object). */
  submit(target, text) {
    const b = this._find(target);
    if (b) this._send(b, text === undefined ? this._value(b) : String(text));
  }

  /** Cancel a box as if the user pressed Esc. */
  cancel(target) {
    const b = this._find(target);
    if (b) this._settle(b, null, 'cancel');
  }

  get anyOpen() { return this.boxes.length > 0; }

  /** Kinds of the open boxes, for the Status header's opening(...) part. */
  get openKinds() { return [...new Set(this.boxes.map(b => b.type))]; }

  /** Open boxes for persistence (SUM §2.5 "boxes"). */
  saveState() {
    const now = Date.now();
    return this.boxes.map(b => ({
      kind: b.type, id: b.id, scope: b.scope, text: this._value(b), remainingMs: b.deadline ? Math.max(0, b.deadline - now) : null,
      opts: { kind: b.kind, title: b.opts.title, limit: b.opts.limit, balloon: b.opts.balloon, min: b.opts.min, max: b.opts.max },
    }));
  }

  /**
   * Reopen saved boxes. Returns their promises so the caller can send the events when they are answered.
   * @returns {{kind:string, id:string, promise:Promise<any>}[]}
   */
  restoreState(list) {
    const out = [];
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || (s.kind !== 'input' && s.kind !== 'communicate' && s.kind !== 'teach')) continue;
      const o = { ...(s.opts || {}), id: s.id, scope: s.scope, defaultText: s.text };
      if (s.remainingMs !== null && s.remainingMs !== undefined) o.timeoutMs = Math.max(1, s.remainingMs);
      const promise = s.kind === 'input' ? this.inputBox(o) : s.kind === 'teach' ? this.teachBox(o) : this.communicateBox(o);
      out.push({ kind: s.kind, id: s.id, promise });
    }
    return out;
  }

  /**
   * Balloon change (BA §12.2): open boxes stay open and are drawn again from the new skin's balloonc* images, with
   * their typed text, caret and focus; each keeps its top-left corner [infer: SSP calls SetBalloon on the open input
   * windows and redraws them, it does not recreate or move them].
   * @param {BalloonSkin} skin
   */
  setSkin(skin) {
    if (!skin) return;
    this.skin = skin;
    for (const b of this.boxes) if (b.el) this._rebuild(b);
  }

  /**
   * Shell change (BA §12.3): open boxes are placed again near the new Stage's characters, except those the visitor
   * dragged [decision]. The runtime swaps in a stage whose characters have no surface yet (EV §2.6): a box whose
   * character has no size stays where it is and is placed on that character's first 'move' with a size (a character
   * emits 'move' once it is placed with its surface's geometry; 'surface' can come before it is placed).
   * @param {object|null} stage
   */
  setStage(stage) {
    this._unwait();
    this.stage = stage || null;
    const later = [];
    for (const b of this.boxes) {
      if (!b.el || b.moved || !b.size) continue;
      if (this._sizeless(b.scope)) later.push(b);
      else this._replace(b);
    }
    if (later.length) this._waitFor(later);
  }

  destroy() {
    this.close();
    this._unwait();
    if (this._offLang) this._offLang();
    this._offLang = null;
    this._unwatchKeys();
  }

  /**
   * What a box says about itself in the UI language: {lang, box (the dialog's name), field (the field's name), hint,
   * placeholder, send, close}. A ghost's title names both; without one the runtime's words do.
   */
  labels(b) {
    const lang = this.lang;
    let own = {};
    if (typeof b.opts.texts === 'function') {
      try { own = b.opts.texts(lang) || {}; } catch (e) { own = {}; }
    }
    const title = own.title || b.opts.title || '';
    const comm = b.type === 'communicate';
    const name = comm ? 'box.communicate' : b.type === 'teach' ? 'box.teach' : 'box.input';
    return {
      lang,
      ownTitle: !!own.title || !b.opts.title,
      box: title || t(name, lang),
      field: title || t(comm ? 'box.say' : name, lang),
      hint: own.hint ?? b.opts.hint ?? '',
      placeholder: own.placeholder ?? b.opts.placeholder ?? '',
      send: t('box.send', lang),
      close: t('box.close', lang),
    };
  }

  /** Put labels() on a drawn box (again after a language change). */
  _label(b) {
    const L = this.labels(b);
    const { el, input } = b;
    if (!el) return;
    el.setAttribute('aria-label', L.box);
    if (L.ownTitle) el.setAttribute('lang', L.lang);   // a ghost's title keeps the page's language
    if (input) {
      input.setAttribute('aria-label', L.field);
      if (L.hint) input.title = L.hint;
      if (L.placeholder) input.placeholder = L.placeholder;
    }
    for (const btn of b.buttons || []) {
      const label = btn.__kind === 'ok' ? L.send : L.close;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('lang', L.lang);
    }
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  _find(target) {
    if (target && typeof target === 'object') return this.boxes.includes(target) ? target : null;
    const key = String(target).toLowerCase();
    const type = key === 'communicatebox' ? 'communicate' : key === 'teachbox' ? 'teach' : '';
    return this.boxes.find(b => b.id === String(target)) || (type ? this.boxes.find(b => b.type === type) : null) || null;
  }

  _value(b) {
    return b.input ? formatInput(b.kind, b.input.value) : b.text;
  }

  _open(type, o) {
    const timeoutMs = Math.max(0, Math.floor(+o.timeoutMs || 0));
    const b = {
      type, id: o.id, scope: Math.max(0, Math.trunc(+o.scope || 0)), kind: o.kind, opts: o, text: String(o.defaultText ?? ''),
      deadline: timeoutMs > 0 ? Date.now() + timeoutMs : 0, timer: 0, done: false, el: null, input: null, resolve: null,
      detailed: !!o.detailed, onSend: type === 'communicate' && typeof o.onSend === 'function' ? o.onSend : null,
    };
    b.promise = new Promise(res => { b.resolve = res; });
    if (timeoutMs > 0) b.timer = setTimeout(() => this._settle(b, null, 'timeout'), timeoutMs);
    this.boxes.push(b);
    if (this.root && hasDom()) {
      try { this._build(b); } catch (e) { log.once('balloon:box', 'balloon: cannot draw the input box', e); }
    }
    this.emit('open', { type, id: b.id });
    return b;
  }

  /**
   * Enter / OK: an input box, the teach box (or a one-shot communicate box) is answered; a communicate box with onSend
   * stays open.
   */
  _send(b, text) {
    if (b.done) return;
    const s = String(text ?? '');
    if (b.type === 'input') { this._settle(b, s, 'ok'); return; }
    if (!s) return;                                   // nothing typed: nothing happens
    if (!b.onSend) { this._settle(b, s, 'ok'); return; }
    b.text = '';
    if (b.input) {
      b.input.value = '';
      try { b.input.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    this.emit('send', { type: b.type, id: b.id, text: s });
    try { b.onSend(s); } catch (e) { log.error('communicate box: sending failed', e); }
  }

  _settle(b, text, reason) {
    if (b.done) return;
    b.done = true;
    if (b.timer) clearTimeout(b.timer);
    const i = this.boxes.indexOf(b);
    if (i >= 0) this.boxes.splice(i, 1);
    if (this._wait && this._wait.pending.delete(b) && !this._wait.pending.size) this._unwait();
    if (!this.boxes.length) this._unwatchKeys();
    if (b.el) {
      const hadFocus = b.el.contains(b.el.getRootNode().activeElement);
      b.el.remove();
      if (hadFocus && b.input) b.input.blur();
    }
    const value = reason === 'ok' ? String(text ?? '') : null;
    if (b.type !== 'communicate') b.resolve({ text: value, timedOut: reason === 'timeout', reason });
    else b.resolve(b.detailed ? { text: value, reason } : value);
    this.emit('close', { type: b.type, id: b.id, reason });
  }

  /** setSkin(): draw an open box again from this.skin, keeping its text, caret, focus and place. */
  _rebuild(b) {
    const old = b.el, input = b.input;
    const doc = typeof document !== 'undefined' ? document : null;
    let active = null;
    try { active = (old.getRootNode && old.getRootNode().activeElement) || null; } catch (e) { active = null; }
    const focused = !!((active && old.contains(active)) || (doc && doc.activeElement && old.contains(doc.activeElement)));
    const sel = input && typeof input.selectionStart === 'number' ? [input.selectionStart, input.selectionEnd, input.selectionDirection] : null;
    if (input) b.text = input.value;
    const { left, top } = old.style;
    old.remove();
    b.el = b.input = null;
    b.buttons = [];
    try {
      this._build(b, { rebuild: true });
    } catch (e) {
      log.once('balloon:box', 'balloon: cannot draw the input box', e);
      return;
    }
    if (!b.el) return;
    b.el.style.left = left;
    b.el.style.top = top;
    if (focused && b.input) {
      try {
        b.input.focus({ preventScroll: true });
        if (sel && typeof b.input.setSelectionRange === 'function') b.input.setSelectionRange(sel[0], sel[1], sel[2] || 'none');
      } catch (e) { /* inputs like date have no caret */ }
    }
    if (this.phone) {
      this._shift(b, b.shift || 0);   // the new element where the old one showed (kept as is while zoomed)
      this._keepVisible();
    }
  }

  /** @param {{rebuild?: boolean}} [o]  rebuild: setSkin redraws an open box (no placement, no focus change) */
  _build(b, { rebuild = false } = {}) {
    addStyle('balloon-box', CSS);
    const img = this.skin.box(b.opts.balloon ?? 3);
    const w = img ? img.w : 317, h = img ? img.h : 42;
    const geo = img ? img.geo : null;
    const cfg = img ? img.cfg : new Map();
    const area = (geo && geo.box) || { x: 8, y: 18, width: w - 16, height: 18 };
    // communicate and teach box: [field][OK][×] inside communicatebox.*; a rectangle too narrow for that keeps its
    // field and gets the buttons just right of it, widening the box past its image
    const buttons = b.type === 'communicate' || b.type === 'teach';
    let field = area, boxW = w, okX = 0;
    if (buttons) {
      const need = BTN.gap + BTN.ok + BTN.between + BTN.close;
      if (area.width - need >= BTN.minField) field = { ...area, width: area.width - need };
      okX = field.x + field.width + BTN.gap;
      boxW = Math.max(w, okX + BTN.ok + BTN.between + BTN.close + 2);
    }
    const el = document.createElement('div');
    el.className = 'smk-box' + (buttons ? ' smk-box-communicate' : '');
    el.setAttribute('role', 'dialog');
    el.style.width = boxW + 'px';
    el.style.height = h + 'px';
    el.style.zIndex = String(Z_BASE + 200);
    const dpr = Math.min(3, Math.max(1, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1));
    // a phone's mobile viewport: a box wider than the phone shrinks to it, OK and × kept on screen (UI §9.11)
    const scale = this.phone && this.phone.mobileView ? Math.min(1, (this.phone.short - 8) / boxW) : boxScale(dpr);
    const cdpr = dpr * scale;   // canvas pixels per image pixel
    if (scale !== 1) { el.style.transformOrigin = '0 0'; el.style.transform = `scale(${scale})`; }
    const bg = document.createElement('canvas');
    bg.width = Math.round(w * cdpr);
    bg.height = Math.round(h * cdpr);
    bg.style.width = w + 'px';
    bg.style.height = h + 'px';
    const src = img ? this.skin.sourceOf(img) : null;
    const ctx = bg.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(cdpr, 0, 0, cdpr, 0, 0);
    let fieldBg = cfgColor(cfg, 'communicatebox.background.color', null);
    if (src) {
      ctx.drawImage(src, 0, 0);
      if (!fieldBg) {
        try {
          // SSP's field colour: the image at the centre of communicatebox.* (LightBlue: white, SSP default: 222,231,255)
          const cx = Math.min(w - 1, Math.max(0, area.x + Math.floor(area.width / 2)));
          const cy = Math.min(h - 1, Math.max(0, area.y + Math.floor(area.height / 2)));
          const p = src.getContext('2d').getImageData(cx, cy, 1, 1).data;
          fieldBg = [p[0], p[1], p[2]];
        } catch (e) { fieldBg = null; }
      }
    } else {
      ctx.fillStyle = 'rgb(225,236,255)';
      ctx.fillRect(0, 0, w, h);
    }
    if (img && img.hit) bg.style.clipPath = img.hit;
    const input = document.createElement('input');
    const k = b.kind;
    input.type = k === 'password' ? 'password' : k === 'date' ? 'date' : k === 'time' ? 'time' : k === 'slider' ? 'range' : 'text';
    if (k === 'time') input.step = '1';
    if (k === 'slider') { input.min = String(b.opts.min ?? 0); input.max = String(b.opts.max ?? 100); }
    if (b.opts.limit > 0) input.maxLength = Math.floor(b.opts.limit);
    if (b.opts.inputMode) input.inputMode = String(b.opts.inputMode);     // the runtime's own boxes (Other percentage…)
    input.value = b.text;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('enterkeyhint', 'send');
    const font = this.skin.font;
    const fh = Math.min(font.height, Math.max(8, field.height - 2));
    const named = cfg.get('communicatebox.font.name');
    const family = `${named ? JSON.stringify(named) + ',' : ''}${font.name}`;
    Object.assign(input.style, {
      left: field.x + 'px', top: field.y + 'px', width: field.width + 'px', height: field.height + 'px',
      font: `${fh}px ${family}`,
      color: css(cfgColor(cfg, 'communicatebox.font.color', null) || cfgColor(cfg, 'font.color', [0, 0, 0])),
      background: fieldBg ? css(fieldBg) : 'rgb(255,255,255)',
    });
    // phones: iOS zooms into a focused field under 16 px [verify]; a 16-px field scaled back to fh (its rectangle, the
    // CSS's 2-px padding and 1-px frame too) looks as an fh-px field does (UI §9.11)
    if (this.phone && fh < 16) {
      const k = 16 / fh;
      Object.assign(input.style, {
        font: `16px ${family}`, width: field.width * k + 'px', height: field.height * k + 'px', padding: `0 ${2 * k}px`,
        borderWidth: k + 'px', transformOrigin: '0 0', transform: `scale(${fh / 16})`,
      });
    }
    // labels (accessible names, tooltips) come from _label(), in the UI language
    const button = (cls, text, kind) => {
      const e = document.createElement('button');
      e.type = 'button';
      e.className = cls;
      e.textContent = text;
      e.__kind = kind;
      return e;
    };
    let ok = null, x;
    if (buttons) {
      ok = button('smk-box-btn smk-box-ok', 'OK', 'ok');           // SSP's "OK" in both languages (message.txt okcancel)
      x = button('smk-box-btn smk-box-close', '×', 'close');
      const top = field.y + 'px', height = field.height + 'px', pen = css(cfgColor(cfg, 'font.color', [0, 0, 0]));
      Object.assign(ok.style, { left: okX + 'px', top, width: BTN.ok + 'px', height, color: pen });
      Object.assign(x.style, { left: okX + BTN.ok + BTN.between + 'px', top, width: BTN.close + 'px', height, color: pen });
      ok.append(glyphCanvas(GLYPHS.ok, pen, cdpr));
      x.append(glyphCanvas(GLYPHS.close, pen, cdpr));
      el.append(bg, input, ok, x);
    } else {
      x = button('smk-box-x', '×', 'close');
      el.append(bg, input, x);
    }
    this.root.appendChild(el);
    b.el = el;
    b.input = input;
    b.buttons = ok ? [ok, x] : [x];
    this._label(b);

    const stopKeys = ev => ev.stopPropagation();
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !isComposing(ev)) { ev.preventDefault(); this._send(b, this._value(b)); }
      else if (ev.key === 'Escape' && !isComposing(ev)) { ev.preventDefault(); this._settle(b, null, 'cancel'); }
    });
    input.addEventListener('keyup', stopKeys);
    input.addEventListener('keypress', stopKeys);
    // keys on the buttons stay in the box too; Esc closes from there as well
    el.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); this._settle(b, null, 'cancel'); }
    });
    el.addEventListener('keyup', stopKeys);
    el.addEventListener('keypress', stopKeys);
    if (ok) {
      ok.addEventListener('mousedown', ev => ev.preventDefault());   // the field keeps the focus (and the soft keyboard)
      ok.addEventListener('click', ev => { ev.stopPropagation(); this._send(b, this._value(b)); });
    }
    x.addEventListener('click', ev => { ev.stopPropagation(); this._settle(b, null, 'cancel'); });
    bg.addEventListener('dblclick', ev => { ev.stopPropagation(); this._settle(b, null, 'cancel'); });
    for (const t of ['click', 'pointerdown', 'pointerup', 'contextmenu', 'wheel']) el.addEventListener(t, ev => ev.stopPropagation());
    // phones: a box taking the focus moves above the keyboard, one losing it goes home
    if (this.phone) for (const t of ['focusin', 'focusout']) el.addEventListener(t, () => this._keepVisible());
    this._drag(b, bg);
    b.size = { w: boxW * scale, h: h * scale };
    if (rebuild) return;
    if (b.opts.pulse) el.classList.add('smk-pulse');
    this._place(b, b.size.w, b.size.h);

    // Take the focus unless the visitor is typing in a field of the page itself.
    const active = document.activeElement;
    const pageEditing = active && active !== document.body && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (pageEditing) {
      el.classList.add('smk-pulse');
    } else {
      try { input.focus({ preventScroll: true }); input.select(); } catch (e) { /* ignore */ }
    }
    // phones: the visual viewport is watched while any box is open, focused or not (a tap on a pulsing box's field
    // raises the keyboard later)
    if (this.phone && !this._offKeys) {
      this._offKeys = watchVisible(typeof window !== 'undefined' ? window : null, vis => this._keepVisible(vis));
    }
  }

  _place(b, w, h) {
    const vv = typeof window !== 'undefined' && window.visualViewport;
    const de = document.documentElement;
    const viewport = { width: de.clientWidth || window.innerWidth, height: vv ? Math.min(vv.height, de.clientHeight || vv.height) : de.clientHeight || window.innerHeight };
    let balloon = null, char = null;
    try {
      const v = this.balloons && this.balloons.views && this.balloons.views.get(b.scope);
      if (v && v.visible) balloon = v.rect;
      const ch = this.stage && this.stage.char ? this.stage.char(b.scope) : null;
      if (ch && ch.rect) char = ch.rect;
    } catch (e) { /* placement falls back to the viewport centre */ }
    const index = this.boxes.filter(o => o !== b && o.scope === b.scope && o.el).length;
    const p = placeBox({ size: { w, h }, at: b.opts.at || null, balloon, char, index, viewport });
    b.el.style.left = p.x + 'px';
    b.el.style.top = p.y + 'px';
  }

  /** _place at the box's current size (setStage). */
  _replace(b) {
    try { this._place(b, b.size.w, b.size.h); } catch (e) { log.once('balloon:box:place', 'balloon: cannot place the input box', e); }
    if (this.phone) this._keepVisible();
  }

  /**
   * Phones (UI §9.11, §6.4): the focused box is shifted up or down into the visible part of the page (above the
   * on-screen keyboard; iOS's own pan counted), every other box goes back home. A `translate`, so left/top stay the
   * box's home (_drag, _rebuild read them) and `transform` the box scale's; vertical only, and nothing moves while the
   * page is zoomed: each box keeps its last shift until the visitor zooms back to 1 [decision].
   * @param {{x:number, y:number, width:number, height:number, scale:number}} [vis] ui/viewport.js visibleRect()
   */
  _keepVisible(vis = visibleRect()) {
    if (!this.phone || zoomed(vis)) return;
    for (const b of this.boxes) {
      if (!b.el) continue;
      const dy = this._hasFocus(b) && b.size ? keepVisible({ y: parseFloat(b.el.style.top) || 0, h: b.size.h }, vis) : 0;
      this._shift(b, Math.round(dy));
    }
  }

  /** the box holds the focus (its root's active element, or the document's where there is no shadow root) */
  _hasFocus(b) {
    let active = null;
    try { active = b.el.getRootNode().activeElement || null; } catch (e) { active = null; }
    const doc = typeof document !== 'undefined' ? document : null;
    return !!((active && b.el.contains(active)) || (doc && doc.activeElement && b.el.contains(doc.activeElement)));
  }

  /**
   * phones: the box shows dy px below its home (the CSS `translate` property: a browser older than Safari 14.1 or
   * Chrome 104 ignores it, and the box stays home; UI §9.11 Item 3 [verify])
   */
  _shift(b, dy) {
    b.shift = dy;
    b.el.style.translate = dy ? `0px ${dy}px` : '';
  }

  /** phones: a drag starts where the box shows, so its shift becomes its home first */
  _fold(b) {
    if (!b.shift) return;
    b.el.style.top = (parseFloat(b.el.style.top) || 0) + b.shift + 'px';
    this._shift(b, 0);
  }

  _unwatchKeys() {
    const off = this._offKeys;
    this._offKeys = null;
    if (off) off();
  }

  /** The scope's character has no size yet (no surface, or its geometry still loading): its rect says nothing. */
  _sizeless(scope) {
    try {
      const ch = this.stage && this.stage.char ? this.stage.char(scope) : null;
      const r = ch && ch.rect;
      return !!r && !(r.width > 0 && r.height > 0);
    } catch (e) { return false; }
  }

  /** setStage: place these boxes when their character gets a size on this.stage; until then they stay put. */
  _waitFor(list) {
    const st = this.stage;
    if (!st || typeof st.on !== 'function') return;
    const pending = new Set(list);
    const check = ev => {
      for (const b of [...pending]) {
        if (b.done || !b.el || b.moved) { pending.delete(b); continue; }
        if ((ev && ev.scope !== undefined && +ev.scope !== b.scope) || this._sizeless(b.scope)) continue;
        pending.delete(b);
        this._replace(b);
      }
      if (!pending.size && this._wait && this._wait.pending === pending) this._unwait();
    };
    const off = st.on('move', check);
    this._wait = { pending, off: () => { if (typeof off === 'function') off(); else if (typeof st.off === 'function') st.off('move', check); } };
  }

  _unwait() {
    const w = this._wait;
    this._wait = null;
    if (w) w.off();
  }

  _drag(b, handle) {
    let start = null;
    handle.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      if (this.phone) this._fold(b);
      start = { x: ev.clientX, y: ev.clientY, left: parseFloat(b.el.style.left) || 0, top: parseFloat(b.el.style.top) || 0 };
      try { handle.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    handle.addEventListener('pointermove', ev => {
      if (!start) return;
      b.moved = true;         // the visitor's place: a shell change does not move it back (setStage)
      b.el.style.left = Math.round(start.left + ev.clientX - start.x) + 'px';
      b.el.style.top = Math.round(start.top + ev.clientY - start.y) + 'px';
    });
    const end = () => { start = null; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
