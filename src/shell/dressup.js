// Dress-up (MAYUNA) state of one scope (SH §4.3, SUM C24, EV §4.11). Pure.
// SSP's model [disasm SPBindProp / SPBindGroup]: each part has an on/off flag; a block of changes (one \![bind], one
// menu pick) is applied, then every touched category is validated, and the parts whose flag differs from before the
// block are the changes, all "off" first, then all "on". addid is a drawing-side expansion: it switches no flag.
import { log } from '../core/log.js';

/** @typedef {{id:number, category:string, part:string, on:boolean}} BindChange */

export class BindState {
  /**
   * @param {import('./surfaces.js').BindGroup[]} groups in descript definition order (Shell.bindGroupsInFileOrder):
   *   that order decides which part a category keeps and the order of info()'s parts
   * @param {Map<string,{mustSelect:boolean, multiple:boolean}>} [options] per category (bindoption)
   * @param {Array<number|string|{items:Array}>} [menu] Shell.dressupMenu(scope): SSP keeps its entries sorted by menu
   *   position, unlisted ones last [disasm CheckEntry], which decides the part a \![bind] by name reaches (apply)
   */
  constructor(groups, options = new Map(), menu = []) {
    this.groups = groups;
    this.options = options;
    /** id -> position in the dress-up menu (menuitem order, submenus walked in place); unlisted ids are absent */
    this._menuPos = new Map();
    let i = 0;
    const walk = list => {
      for (const x of list || []) {
        if (typeof x === 'number') { if (!this._menuPos.has(x)) this._menuPos.set(x, i); } else if (x && typeof x === 'object') walk(x.items);
        i++;
      }
    };
    walk(menu);
    this.byId = new Map();
    for (const g of groups) if (!this.byId.has(g.id)) this.byId.set(g.id, g);
    this.byCategory = new Map();
    for (const g of groups) {
      let l = this.byCategory.get(g.category);
      if (!l) this.byCategory.set(g.category, l = []);
      l.push(g);
    }
    /** target id -> groups whose addid lists it (drawn while any of them is on) */
    this._adders = new Map();
    for (const g of groups) {
      for (const a of g.addid || []) {
        if (a === g.id || !this.byId.has(a)) continue;
        let l = this._adders.get(a);
        if (!l) this._adders.set(a, l = []);
        l.push(g);
      }
    }
    /** part flags: ids switched on (by default, \![bind] or the menu) */
    this.on = new Set();
    /** drawn-state changes of the last apply()/set() (flags plus addid expansion), for the character views */
    this.drawChanges = [];
    this.version = 0;
    this._before = null;
    this._touched = null;
    this.reset();
  }

  /** back to the descript defaults (no change events) */
  reset() {
    this.on.clear();
    for (const g of this.groups) if (g.default) this.on.add(g.id);
    this.version++;
  }

  /** restore a saved list of ON ids (unknown ids are dropped) */
  restore(ids) {
    this.on.clear();
    for (const id of ids || []) if (this.byId.has(+id)) this.on.add(+id);
    this.version++;
  }

  /** drawn: the part is on, or an on part lists it in its addid (SH §4.3) */
  isOn(id) { return this.on.has(id) || this._added(id, i => this.on.has(i)); }

  /** worn: the part's own flag (menu check mark, OnNotifyDressupInfo, saved state) */
  isWorn(id) { return this.on.has(id); }

  /** ON group ids (flags), ascending */
  onIds() { return [...this.on].sort((a, b) => a - b); }

  _added(id, has) {
    const l = this._adders.get(id);
    return !!l && l.some(g => has(g.id));
  }

  /**
   * \![bind,category,part,value] (value '1' on, '0' off, ''/undefined toggle; anything else: no-op, logged once).
   * @returns {BindChange[]} parts whose flag changed, off first (stable)
   */
  apply(category, part, value) {
    const v = value === undefined || value === null ? '' : String(value).trim();
    if (v !== '' && v !== '0' && v !== '1') {
      log.once('shell:bindvalue:' + v, 'shell: \\![bind] with a non-numeric value ignored', v);
      return this._none();
    }
    category = String(category ?? '');
    part = String(part ?? '');
    const list = this.byCategory.get(category);
    if (!list) { log.once('shell:bindcat:' + category, 'shell: unknown dress-up category', category); return this._none(); }
    if (part === '') {
      if (v !== '0') return this._none();
      this._begin();
      for (const g of list) this._flag(g, false);
      return this._end();
    }
    const g = this._entry(list, part);
    if (!g) { log.once('shell:bindpart:' + category + ':' + part, 'shell: unknown dress-up part', category, part); return this._none(); }
    this._begin();
    const turnOn = v === '1' || (v === '' && !this.on.has(g.id));
    if (turnOn) this._turnOn(g); else this._flag(g, false);
    return this._end();
  }

  /**
   * The one part a \![bind] by name reaches when several groups share the category and part (DSLGS's マフラー/黄色):
   * the first in SSP's entry order, i.e. the lowest menu position, unlisted ones after in definition order (SSP's
   * lookup walks the sorted entries and stops at the first match [disasm SPBindProp 0x5d8c00]; SH §4.3.1).
   */
  _entry(list, part) {
    let best = null, bestPos = Infinity;
    for (const g of list) {
      if (g.part !== part) continue;
      const p = this._menuPos.has(g.id) ? this._menuPos.get(g.id) : Infinity;
      if (!best || p < bestPos) { best = g; bestPos = p; }
    }
    return best;
  }

  /** Switch one group by id (dress-up menu). value: true/false or undefined = toggle */
  set(id, value) {
    const g = this.byId.get(id);
    if (!g) return this._none();
    this._begin();
    const turnOn = value === undefined ? !this.on.has(id) : !!value;
    if (turnOn) this._turnOn(g); else this._flag(g, false);
    return this._end();
  }

  _opt(category) { return this.options.get(category) || { mustSelect: false, multiple: false }; }

  _none() { this.drawChanges = []; return []; }

  _begin() {
    this._before = new Map();     // id -> flag before the block (touched parts only)
    this._touched = [];           // touched parts, in order of first touch
  }

  _flag(g, v) {
    if (!this._before.has(g.id)) { this._before.set(g.id, this.on.has(g.id)); this._touched.push(g); }
    if (v) this.on.add(g.id); else this.on.delete(g.id);
  }

  /** a part turned on: without `multiple` the category's other parts go off (SSP DisableAllEntry [disasm]) */
  _turnOn(g) {
    if (!this._opt(g.category).multiple) {
      for (const o of this.byCategory.get(g.category)) if (o !== g && this.on.has(o.id)) this._flag(o, false);
    }
    this._flag(g, true);
  }

  /**
   * End of a block: validate each touched category (SSP SPBindGroup::ValidateEntryFlag [disasm]): without `multiple`
   * only the first part (definition order) that is on stays on; with `mustselect` and nothing on, every part whose
   * `bindgroupN.default` is true is switched on again (none: the category stays empty). Then the net changes.
   */
  _end() {
    const cats = [...new Set(this._touched.map(g => g.category))];
    for (const c of cats) {
      const list = this.byCategory.get(c), o = this._opt(c);
      if (!o.multiple) {
        let kept = false;
        for (const g of list) if (this.on.has(g.id)) { if (kept) this._flag(g, false); else kept = true; }
      }
      if (o.mustSelect && !list.some(g => this.on.has(g.id))) for (const g of list) if (g.default) this._flag(g, true);
    }
    const before = this._before, touched = this._touched;
    this._before = this._touched = null;
    const offs = [], ons = [];
    for (const g of touched) {
      const now = this.on.has(g.id);
      if (before.get(g.id) !== now) (now ? ons : offs).push({ id: g.id, category: g.category, part: g.part, on: now });
    }
    const changes = offs.concat(ons);
    this.drawChanges = changes.length ? this._drawDiff(before, changes) : [];
    if (changes.length) this.version++;
    return changes;
  }

  /** drawn-state changes (flags plus addid targets) between `before` (touched flags) and now, off first */
  _drawDiff(before, changes) {
    if (!this._adders.size) return changes;
    const was = id => (before.has(id) ? before.get(id) : this.on.has(id));
    const drawnBefore = id => was(id) || this._added(id, was);
    const ids = [];
    const seen = new Set();
    for (const c of changes) {
      for (const id of [c.id, ...(this.byId.get(c.id).addid || [])]) if (this.byId.has(id) && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    const offs = [], ons = [];
    for (const id of ids) {
      const a = drawnBefore(id), b = this.isOn(id);
      if (a === b) continue;
      const g = this.byId.get(id);
      (b ? ons : offs).push({ id, category: g.category, part: g.part, on: b });
    }
    return offs.concat(ons);
  }

  /**
   * OnNotifyDressupInfo references for this scope (EV §4.11, SH §4.3.2; SSP NotifyBindInfo / GetNotifyEntry [disasm]):
   * `scope \x01 category \x01 part \x01 options \x01 1|0 \x01 thumbnail`. Options: those of `default` (the part's
   * bindgroupN.default), `mustselect`, `multiple` that apply, comma-joined. Order: categories in `order`
   * (Shell.bindCategoryOrder; any others after, in creation order), parts in definition order. The thumbnail is
   * sent only when `hasFile(name)` says the shell has that file.
   * @param {{order?: string[], hasFile?: (name:string)=>boolean}} [o]
   */
  info(scope, { order = null, hasFile = null } = {}) {
    const cats = [], seen = new Set();
    for (const c of order || []) if (this.byCategory.has(c) && !seen.has(c)) { seen.add(c); cats.push(c); }
    for (const c of this.byCategory.keys()) if (!seen.has(c)) { seen.add(c); cats.push(c); }
    const out = [];
    for (const c of cats) {
      const o = this._opt(c);
      for (const g of this.byCategory.get(c)) {
        const opts = [];
        if (g.default) opts.push('default');
        if (o.mustSelect) opts.push('mustselect');
        if (o.multiple) opts.push('multiple');
        const thumb = g.thumbnail && hasFile && hasFile(g.thumbnail) ? g.thumbnail : '';
        out.push(`${scope}\x01${c}\x01${g.part}\x01${opts.join(',')}\x01${this.on.has(g.id) ? 1 : 0}\x01${thumb}`);
      }
    }
    return out;
  }
}
