// The runtime's right-click menu (ssp-ui.md §2; SUMMARY C26, C27, C29). The event loop decides when it opens (a right
// click the ghost did not answer); this module asks the ghost for captions, visibility and site lists each time,
// builds SSP's menu (UI §2.1 / §2.11: Recommendations ▸, Portal site ▸, Shell scaling ▸,
// Balloon scaling ▸, Utilities ▸, Options ▸ (UI §2.13), Change ghost ▸, Call ghost ▸, Shell ▸, Clothes/Dressup ▸, Balloon ▸, Information ▸,
// Language ▸, Iconify, Move character window, Close, Quit; the abbreviated menu of UI §2.2 for scope ≥ 1; no Talk item;
// which character's menu a click opens is the clicked one's `popupmenu.type`, UI §2.1 notes),
// draws it as ssp.exe's owner-drawn menu (UI §2.3: SSP's device-pixel metrics, the menu images 1:1 and the colours of
// the descripts with the SHIORI's menu.* answers on top, else SSP's own look), and runs the picked item. The runtime's
// own captions come in the visitor's UI language (core/i18n.js, UI §2.10); the ghost's captions stay as the ghost wrote
// them. Each ghost on screen has its own Menu: Change ghost ▸ / Call ghost ▸ / Close act on that ghost, Quit on all.
import { log } from '../core/log.js';
import { getRoot, addStyle, Z_BASE } from './root.js';
import { SCALE_STEPS, currentDpr, displayPercent, normPercent } from '../core/scaling.js';
import { t, LANGUAGES, UI_LANGS, normLangPref } from '../core/i18n.js';
import { InfoWindow, aboutContent, readmeContent, termsContent, infoFlags } from './info.js';
import { sharedThumbnail, findLoadable, bannerUrls } from './thumbnail.js';
import { parseBool } from '../sakura/commands.js';

/** 'sakura' | 'kero' | 'char<n>' */
export function scopePrefix(scope) {
  return scope === 0 ? 'sakura' : scope === 1 ? 'kero' : `char${scope}`;
}

/** a reply Map (or plain object) read by id */
const replyOf = (res, id) => (res instanceof Map ? res.get(id) : res ? res[id] : undefined);

/**
 * The two ids ssp.exe asks first at every right-click menu open, of the **clicked** character, before any caption:
 * `<p>.popupmenu.visible`, then `<p>.popupmenu.type`, both always (type also when visible is 0) [disasm 2.9.10
 * CCharWndCode::OnCWContextMenuSSP 0x41af2c..0x41b014; res: `scratch/ayame_u8.log` 1637–1650] (UI §2.1 notes).
 * @param {number} scope the clicked character
 */
export function menuGateIds(scope) {
  const p = scopePrefix(scope);
  return [`${p}.popupmenu.visible`, `${p}.popupmenu.type`];
}

/**
 * ssp.exe's wtoul_impl [disasm 2.9.10 0x5ae280..0x5ae2df]: leading ' ', U+3000 and tabs skipped; `0x` / `0X` then base
 * 16 on the rest, else base 10, through the CRT's wcstoul: its own leading white space, an optional sign, the digits
 * of the base up to the first other character (none: 0; base 16 takes one more `0x`); above 0xFFFFFFFF: 0xFFFFFFFF; a
 * `-` negates modulo 2^32. ASCII digits only [disasm _wcstoxl 0xacdeaa–0xacdee0: c − '0' of a full-width digit is
 * past the base].
 * @returns {number} 0 … 0xFFFFFFFF
 */
export function sspWtoul(s) {
  let t = String(s ?? '').replace(/^[ \u3000\t]+/, '');
  let base = 10;
  if (t[0] === '0' && (t[1] === 'x' || t[1] === 'X')) { base = 16; t = t.slice(2); }
  t = t.replace(/^[\t\n\v\f\r ]+/, '');
  let neg = false;
  if (t[0] === '+' || t[0] === '-') { neg = t[0] === '-'; t = t.slice(1); }
  if (base === 16 && /^0[xX][0-9a-fA-F]/.test(t)) t = t.slice(2);
  const digits = (base === 16 ? /^[0-9a-fA-F]*/ : /^[0-9]*/).exec(t)[0];
  let v = 0;
  for (const c of digits) {
    v = v * base + parseInt(c, base);
    if (v > 0xFFFFFFFF) return 0xFFFFFFFF;
  }
  return neg ? (0x100000000 - v) % 0x100000000 : v;
}

/**
 * `<p>.popupmenu.type` read as ssp.exe reads it [disasm 2.9.10 OnCWContextMenuSSP 0x41b019..0x41b06e]: no answer (a
 * 204, another status, an empty string: GetString 0x642554) -> null (the clicked character's own menu); the whole
 * value `sakura` (any case) -> 0, `kero` -> 1; starting with `char` (any case) -> sspWtoul of the rest; anything else
 * -> sspWtoul of the whole value (so any other word, `char`, ` ` -> 0, `-1` -> 0xFFFFFFFF). A scope, not a kind:
 * UKADOC's "0 = main menu, 1 = abbreviated" is scopes 0 and 1 [doc UKADOC:res].
 * @returns {number|null}
 */
export function popupTypeScope(value) {
  if (value == null || value === '') return null;
  const v = String(value);
  if (/^sakura$/i.test(v)) return 0;
  if (/^kero$/i.test(v)) return 1;
  return sspWtoul(/^char/i.test(v) ? v.slice(4) : v);
}

/**
 * Whether a click on `clicked` opens a menu, and whose (UI §2.1 notes), from the gate's replies (menuGateIds):
 * `visible` = ParseBool of `<p>.popupmenu.visible`, default shown (GetStringBool(…, 1) 0x6424c0: `0 false off no ng
 * none disable(d)`, a zero number hide; no, empty or other answers show) [disasm 0x41af93..0x41afcd, 0x41b082]; `target`
 * = the character whose menu is shown: popupTypeScope of `<p>.popupmenu.type` when that window exists (GetCharWnd
 * 0x49ec70: 0 always, 1 the kero window, n ≥ 2 a `\p[n]` window made; `has`), else the clicked one [0x41b08b..0x41b098].
 * @param {number} clicked
 * @param {Map|object} res the gate's replies
 * @param {(scope:number) => boolean} [has] whether that character's window exists (default: 0 and 1)
 * @returns {{visible: boolean, target: number}}
 */
export function menuTarget(clicked, res, has = s => s === 0 || s === 1) {
  const [visibleId, typeId] = menuGateIds(clicked);
  const visible = parseBool(replyOf(res, visibleId)) !== 0;
  const t = popupTypeScope(replyOf(res, typeId));
  return { visible, target: t === null || t === clicked || !has(t) ? clicked : t };
}

/** `<p>.popupmenu.applybindtoself` of the clicked character (CheckApplyBindToSelf [disasm 2.9.10 0x41cd47]) */
export const applyBindId = scope => `${scopePrefix(scope)}.popupmenu.applybindtoself`;

/**
 * Whose dress-up Clothes/Dressup ▸ lists and toggles (the bind scope) [disasm 2.9.10 CheckApplyBindToSelf
 * 0x41cca0..0x41cdb4]: the menu's own character when it is the clicked one (nothing asked); else ParseBool of the
 * clicked one's `applybindtoself`, default 1: 1 the clicked character's parts, 0 the menu owner's.
 */
export function bindScopeOf(clicked, target, res) {
  if (clicked === target) return target;
  return parseBool(replyOf(res, applyBindId(clicked))) === 0 ? target : clicked;
}

/**
 * The requests of a right-click menu open, in ssp.exe's order (UI §2.1 notes): the gate (menuGateIds) of the clicked
 * character; no menu when `visible` says so; then one batch for the shown menu's owner (`target`): the clicked one's
 * `applybindtoself` first when that is another character (ModifyPopupMenu's first call [disasm 2.9.10 0x41cdf2,
 * 0x4959f2]), then `ids(target)` (its captions). A failing ask counts as no answers. null: no menu, or `live()` went
 * false between the rounds (a newer open).
 * @param {(ids:string[]) => Promise<Map<string, string|null>>} ask
 * @param {number} clicked
 * @param {{has?: (scope:number) => boolean, ids?: (scope:number) => string[], live?: () => boolean}} [o]
 * @returns {Promise<{target:number, bindScope:number, res:Map, gate:Map}|null>}
 */
export async function askMenu(ask, clicked, { has, ids = s => menuResourceIds(s), live = () => true } = {}) {
  const safe = async list => { try { return (await ask(list)) || new Map(); } catch (e) { return new Map(); } };
  const gate = await safe(menuGateIds(clicked));
  if (!live()) return null;
  const { visible, target } = menuTarget(clicked, gate, has);
  if (!visible) return null;
  const res = await safe([...(target !== clicked ? [applyBindId(clicked)] : []), ...ids(target)]);
  if (!live()) return null;
  return { target, bindScope: bindScopeOf(clicked, target, res), res, gate };
}

const pair = id => [`${id}.visible`, `${id}.caption`];

/**
 * Resource IDs to request when the menu of `scope` opens, in one batch (C29; UI §2.11). Where SSP has a legacy name
 * it asks that one first [disasm]; the table ids (dress-up, explorer, move, close, quit) carry no scope prefix in any
 * menu, the abbreviated menu's recommend ids do (`kero.recommendrootbutton.visible` …). `leavepassivebutton.*` only
 * with the developer functions (Reset passive mode, UI §2.11); `configurationrootbutton.*` / `configurationbutton.*`
 * only with Options ▸ (UI §2.13), after Utilities ▸'s ids, root first, each visible before its caption [res: an SSP
 * request log, `scratch/ayame.log`]. `scope` is the shown menu's owner; the clicked character's gate
 * (`popupmenu.visible` / `.type`, menuGateIds) is asked before, in a round of its own (askMenu).
 * @param {number} scope
 * @param {{devFunctions?: boolean, preferences?: boolean}} [o]
 */
export function menuResourceIds(scope, { devFunctions = false, preferences = false } = {}) {
  const p = scopePrefix(scope);
  if (scope !== 0) {
    return [
      `${p}.recommendrootbutton.visible`, `${p}.recommendbuttoncaption`, `${p}.recommendrootbutton.caption`, `${p}.recommendsites`,
      ...pair('dressuprootbutton'), ...pair('dressupexplorerbutton'), ...pair('charmovebutton'),
      ...pair('closebutton'), ...pair('quitbutton'),
    ];
  }
  return [
    'recommendrootbutton.visible', 'sakura.recommendbuttoncaption', 'recommendrootbutton.caption', 'sakura.recommendsites',
    'portalrootbutton.visible', 'sakura.portalbuttoncaption', 'portalrootbutton.caption', 'sakura.portalsites',
    // the balloonscale* ids are not in UKADOC; ssp.exe asks for them (UI §2.1 #9). Every *.caption has a *.visible.
    'shellscalerootbutton.visible', 'shellscalerootbutton.caption', 'shellscaleotherbutton.visible', 'shellscaleotherbutton.caption',
    'balloonscalerootbutton.visible', 'balloonscalerootbutton.caption', 'balloonscaleotherbutton.visible', 'balloonscaleotherbutton.caption',
    ...pair('utilityrootbutton'), ...(devFunctions ? pair('leavepassivebutton') : []), ...pair('resettodefaultbutton'),
    ...(preferences ? [...pair('configurationrootbutton'), ...pair('configurationbutton')] : []),
    ...pair('ghostrootbutton'), ...pair('callghostrootbutton'), ...pair('shellrootbutton'), ...pair('dressuprootbutton'), ...pair('dressupexplorerbutton'),
    ...pair('balloonrootbutton'),
    ...pair('inforootbutton'), ...pair('firststaffbutton'), 'readmebutton.visible', 'readmebuttoncaption', 'readmebutton.caption',
    ...pair('termsbutton'), ...pair('helpbutton'), ...pair('aistatebutton'), ...pair('rateofusebutton'), ...pair('systeminfobutton'),
    ...pair('hidebutton'), ...pair('charmovebutton'), ...pair('closebutton'), ...pair('quitbutton'),
  ];
}

/**
 * Site list resource (EV §5.3): entries split by \x02, fields by \x01: title, url, banner, talk.
 * A title of '-' is a separator.
 */
export function parseSiteList(value) {
  if (value == null || value === '') return [];
  const out = [];
  for (const entry of String(value).split('\x02')) {
    if (!entry.trim()) continue;
    const [title = '', url = '', banner = '', talk = ''] = entry.split('\x01');
    if (title.trim() === '-') out.push({ separator: true });
    else out.push({ title, url: url.trim(), banner, talk });
  }
  return out;
}

/**
 * '&X' marks the access key X; '&&' is a literal '&' (EV §5.4). The text after the caption's last '\t' is its
 * accelerator, drawn right-aligned (SSP's "Close (&W)\tCtrl+W") [disasm SPMenu::DrawItem]; Sumika's own captions carry
 * none (UI §2.11), so only a ghost's caption can have one.
 * @returns {{text:string, key:string|null, parts:{text:string, key?:boolean}[], accel:string|null}}
 */
export function parseCaption(caption) {
  let s = String(caption ?? '');
  const tab = s.lastIndexOf('\t');
  const accel = tab >= 0 ? s.slice(tab + 1) : null;
  if (tab >= 0) s = s.slice(0, tab);
  const parts = [];
  let key = null;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&' && s[i + 1] === '&') { buf += '&'; i++; continue; }
    if (c === '&' && i + 1 < s.length && key === null) {
      if (buf) parts.push({ text: buf });
      buf = '';
      const k = s[++i];
      parts.push({ text: k, key: true });
      key = k.toLowerCase();
      continue;
    }
    buf += c;
  }
  if (buf) parts.push({ text: buf });
  return { text: parts.map(p => p.text).join(''), key, parts, accel };
}

const nonEmpty = v => (v == null || String(v).trim() === '' ? null : String(v));
/** ghost text as a caption: a literal '&' doubled, so it never becomes an access key */
const esc = s => String(s ?? '').replace(/&/g, '&&');

/** a site-list row's reason ('needs Kawari' in `lang`, else its note as given), or null */
const rowNote = (g, lang) => (g.needs ? t('menu.needs', lang, { engine: g.needs }) : g.note || null);

/** a ghost, shell or balloon row's thumbnails (`thumbs`, URLs) for the thumbnail window (UI §2.14), when it has any */
const thumbsOf = g => (Array.isArray(g.thumbnails) && g.thumbnails.length ? { thumbs: g.thumbnails.map(String) } : {});

/**
 * The thumbnail window's key for a row in one of SSP's thumbnail ranges [disasm 2.9.10 CCharWndCode::OnCWMenuSelect
 * 0x41b740] — Shell ▸ (6500 + i), Change ghost ▸ (35000 + i), Call ghost ▸ (20000 + i), Balloon ▸ (50000 + i),
 * Recommendations ▸ (9000 + i), Portal site ▸ (11000 + i), a dress-up part (13000 + i) — standing for its command id
 * (a balloon listed twice has one id, so one key); null for any other row. Headlines and plugins have no menu here.
 */
export function thumbKey(action) {
  const a = action || {};
  switch (a.type) {
    case 'ghost': case 'callghost': case 'shell': case 'balloon': return `${a.type}:${a.id}`;
    case 'dressup': return `dressup:${a.scope | 0}:${a.id}`;
    case 'site': return `${a.kind}:${a.index}`;
    default: return null;
  }
}

/**
 * Change ghost ▸ entries (UI §2.1 #12): every ghost of the site by its descript name, in the order given
 * (Site.ghostList: SSP's name order, ties by folder [observed]); the running one checked and
 * enabled (a pick reloads it: its goodbye, a cold boot of itself, OnGhostChanged naming itself; EV §2.5), ghosts whose
 * engine the runtime lacks disabled with their reason ('needs Kawari'), which the menu shows next to the name, outside
 * the label, so a long name cannot cut it off. `needs` (the engine's name) words the reason in `lang`; without it
 * `note` shows as given. A ghost on screen in another slot (`elsewhere`, several ghosts) is greyed without a check
 * [disasm 2.9.10 `CSakuraWnd::InitGhostMenu` 0x49b800: every booted ghost greyed, then the menu's own one checked and
 * enabled again]. The check is drawn as SSP's dot (`radio`): the rows' command ids 35000 + i are in its dot range
 * (UI §2.3) [disasm]. `thumbnails` (URLs) go on the row as `thumbs`: an enabled row shows one while it is selected
 * (UI §2.14).
 * @param {{id:string, name:string, current?:boolean, note?:string|null, needs?:string|null, elsewhere?:boolean,
 *   thumbnails?:string[]}[]} ghosts
 * @param {string} [lang] UI language
 */
export function ghostItems(ghosts, lang = 'en') {
  return ghosts.map(g => {
    const note = rowNote(g, lang);
    return {
      kind: 'item',
      label: esc(g.name || g.id),
      lang: '',                          // the ghost's own name: not in the UI language
      checked: !!g.current,
      radio: true,
      disabled: !!g.elsewhere || !!note,
      note,
      action: { type: 'ghost', id: g.id },
      ...thumbsOf(g),
    };
  });
}

/**
 * Call ghost ▸ entries (UI §2.1 #13): the same rows, order and labels as Change ghost ▸ (SSP fills both in one loop
 * [disasm `CSakuraWnd::InitGhostMenu`]; ids 20000 + i, so the check is SSP's dot). The menu's own ghost checked and
 * greyed; a ghost on screen in another slot (`elsewhere`) greyed without a check [disasm]; a ghost whose engine is
 * missing greyed with its reason [decision, as Change ghost ▸]; while a site's cap is reached (`full`;
 * data-max-ghosts, none by default, as SSP) every other row greyed with "up to {n} at once". n is `full` when it is a
 * number, else the number of ghosts on screen (current + elsewhere), which is the cap whenever the set is full.
 * Thumbnails as ghostItems (ProcessThumbnail takes both ranges to the one ghost list [disasm 0x41c4c1]).
 * @param {{id:string, name:string, current?:boolean, note?:string|null, needs?:string|null, elsewhere?:boolean,
 *   full?:boolean|number, thumbnails?:string[]}[]} ghosts
 * @param {string} [lang] UI language
 */
export function callItems(ghosts, lang = 'en') {
  const list = ghosts || [];
  const onScreen = list.filter(g => g.current || g.elsewhere).length;
  return list.map(g => {
    const up = !!g.current || !!g.elsewhere;
    const n = typeof g.full === 'number' ? g.full : onScreen;
    const note = rowNote(g, lang) || (g.full && !up ? t('menu.callLimit', lang, { n }) : null);
    return {
      kind: 'item',
      label: esc(g.name || g.id),
      lang: '',
      checked: !!g.current,
      radio: true,
      disabled: up || !!note,
      note,
      action: { type: 'callghost', id: g.id },
      ...thumbsOf(g),
    };
  });
}

/**
 * Shell ▸ entries (UI §2.11): the visible shells in menu order (core/shells.js) by their descript name; the current
 * one is checked (CheckMenuItem, which SSP's owner-drawn menu draws as its dot for the ids 6500 + i, UI §2.3
 * [disasm]) and stays enabled: picking it reloads the shell with its events [code].
 * @param {{id:string, name:string, current?:boolean}[]} shells
 */
export function shellItems(shells) {
  return (shells || []).map(s => ({
    kind: 'item', label: esc(s.name || s.id), lang: '', checked: !!s.current, radio: true, action: { type: 'shell', id: s.id },
    ...thumbsOf(s),
  }));
}

/** SSP's default "Max. name length in ghost/balloon menu" [code: the constructor sets 25] */
export const BALLOON_NAME_MAX = 25;

/** A name cut to `max` UTF-16 units plus '...' (SSP counts wchar_t), never inside a surrogate pair. */
export function cutName(name, max = BALLOON_NAME_MAX) {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  let n = max;
  const c = s.charCodeAt(n - 1);
  if (c >= 0xd800 && c <= 0xdbff) n--;
  return s.slice(0, n) + '...';
}

/**
 * Balloon ▸ entries (UI §2.11): the ghost descript's balloons (top group) and a separator when there are any, then
 * every installed balloon in name order; names cut to 25 characters plus '...'. The balloon in use has a check on its
 * first row only [infer: Win32 MF_BYCOMMAND], drawn as SSP's dot (ids 50000 + i, UI §2.3) [disasm]; every row is
 * enabled, the current one included (a re-pick reloads it).
 * @param {{top?: {id, name, current?}[], all?: {id, name, current?}[]}} balloons
 */
export function balloonItems(balloons) {
  const top = (balloons && Array.isArray(balloons.top) && balloons.top) || [];
  const all = (balloons && Array.isArray(balloons.all) && balloons.all) || [];
  let marked = false;
  const row = b => {
    const checked = !!b.current && !marked;
    if (checked) marked = true;
    const full = String(b.name || b.id);
    const label = cutName(full);
    const it = { kind: 'item', label: esc(label), lang: '', checked, radio: true, action: { type: 'balloon', id: b.id }, ...thumbsOf(b) };
    if (label !== full) it.title = full;
    return it;
  };
  const out = top.map(row);
  if (out.length) out.push({ kind: 'sep' });
  out.push(...all.map(row));
  return out;
}

/**
 * Clothes/Dressup ▸ parts (UI §2.11) from `Stage.dressupMenu(scope)` data (SH §4.3.1):
 * manual: the menuitem order, 'category - part' labels (always, even when equal), menuitemex submenus, separators;
 * auto: categories with ≥ 2 parts as submenus of part names (checked while any part is worn), a separator, then the
 * single-part categories flat ('category - part', just 'part' when the two are equal in any case); a scope with one
 * category is all flat [disasm]; hidden: nothing. Every part is a check item, checked while worn, the check drawn as
 * SSP's dot (`dot`: the parts' ids 13000 + i are in its dot range; a category submenu's auto id gets the tick, UI §2.3)
 * [disasm `CCharWndCode::UpdateBindMenu`]. Ghost text: '&' doubled.
 * @param {{mode:'manual'|'auto'|'hidden', entries?: object[]}|null} data
 * @param {number} scope the dress-up's scope (the action's)
 */
export function dressupItems(data, scope = 0, thumbs = null) {
  if (!data || data.mode === 'hidden') return [];
  const entries = Array.isArray(data.entries) ? data.entries : [];
  // a part's thumbnail (its bind group's third field) is looked up when its row is selected (UI §2.14)
  const find = thumbs && typeof thumbs.part === 'function' ? thumbs.part : null;
  const pick = (label, on, id, thumb) => ({
    kind: 'item', label: esc(label), lang: '', checked: !!on, toggle: true, dot: true, action: { type: 'dressup', scope, id },
    ...(thumb && find ? { thumbs: () => find(thumb) } : {}),
  });
  if (data.mode === 'auto') {
    const cats = entries.filter(e => e && e.type === 'category' && Array.isArray(e.parts) && e.parts.length);
    const flat = cats.length === 1;
    const multi = flat ? [] : cats.filter(c => c.parts.length >= 2);
    const single = flat ? cats : cats.filter(c => c.parts.length < 2);
    const out = multi.map(c => ({
      kind: 'sub', label: esc(c.category), lang: '', checked: !!c.on,
      items: c.parts.map(p => pick(p.part, p.on, p.id, p.thumbnail)),
    }));
    if (out.length && single.length) out.push({ kind: 'sep' });
    for (const c of single) {
      for (const p of c.parts) {
        const same = String(c.category).toLowerCase() === String(p.part).toLowerCase();
        out.push(pick(same ? p.part : `${c.category} - ${p.part}`, p.on, p.id, p.thumbnail));
      }
    }
    return out;
  }
  const walk = list => list.map(e => {
    if (!e) return null;
    if (e.type === 'sep') return { kind: 'sep' };
    if (e.type === 'menu') return { kind: 'sub', label: esc(e.name), lang: '', items: walk(Array.isArray(e.entries) ? e.entries : []) };
    if (e.type === 'part') return pick(`${e.category} - ${e.part}`, e.on, e.id, e.thumbnail);
    return null;
  }).filter(Boolean);
  return walk(entries);
}

/**
 * Language ▸ (UI §2.10): SSP's language packs by their names (Japanese, English; the same in every language), a
 * separator and Use System Lang. The language in effect has the bullet; Use System Lang. is checked while the choice
 * follows the browser [observed: SSP marks them the same way].
 * @param {string} lang the language in effect
 * @param {string} pref the stored choice ('ja' | 'en' | 'system')
 */
export function languageItems(lang, pref) {
  const p = normLangPref(pref);
  return [
    ...UI_LANGS.map(l => ({ kind: 'item', label: LANGUAGES[l].name, lang: 'en', checked: l === lang, radio: true, action: { type: 'language', pref: l } })),
    { kind: 'sep' },
    { kind: 'item', label: t('menu.language.system', lang), lang: 'en', checked: p === 'system', toggle: true, action: { type: 'language', pref: 'system' } },
  ];
}

/**
 * Shell scaling ▸ / Balloon scaling ▸ entries (UI §2.1 #8/#9): Default (match display), standing in for SSP's
 * "Additional settings (Same as ghost preferences)" (it opens the Ghost preferences dialog, which a browser does not
 * have), then Other percentage…, a separator and SSP's percentages from 300 % down to 20 %. The display's own
 * percentage (round(dpr × 100)) and a chosen one that is not in the list join it in order. The percentage in effect
 * has the bullet (with no choice: the display's); the display's carries the note 'display'. Default is greyed out
 * while nothing is chosen (the size already follows the display). On phones (UI §9.11) no choice is the fit: its
 * percentage (`fit`) has the bullet and joins the list, and Default reads "Default (fit to screen)".
 * @param {'shell'|'balloon'} target
 * @param {number|null} percent the ghost's choice (core/scaling.js), null = follow the display
 * @param {number} dpr devicePixelRatio
 * @param {{other?: string|null, otherLang?: string, otherVisible?: boolean, lang?: string, fit?: number|null}} [captions]
 *   Other percentage…'s caption from the ghost (shellscaleotherbutton.caption …; null: ours) and its lang attribute,
 *   whether the ghost leaves it enabled (shellscaleotherbutton.visible …; 0 greys it, UI §2.11), the UI language of our
 *   own captions, and the phone fit's percentage (UserScaling.info().fit; none off a phone)
 */
export function scaleItems(target, percent, dpr, { other = null, otherLang, otherVisible = true, lang = 'en', fit = null } = {}) {
  const chosen = normPercent(percent);
  const disp = displayPercent(dpr);
  const hasFit = Number.isFinite(fit);
  const now = chosen !== null ? chosen : hasFit ? fit : disp;
  const list = [...new Set([...SCALE_STEPS, disp, now])].sort((a, b) => b - a);
  const otherItem = { kind: 'item', label: other ?? t('menu.scale.other', lang), action: { type: 'scale-other', target } };
  if (other != null && otherLang !== undefined) otherItem.lang = otherLang;
  if (!otherVisible) otherItem.disabled = true;
  return [
    { kind: 'item', label: t(hasFit ? 'menu.scale.defaultPhone' : 'menu.scale.default', lang), disabled: chosen === null,
      action: { type: 'scale', target, percent: null } },
    otherItem,
    { kind: 'sep' },
    ...list.map(p => ({
      kind: 'item', label: `${p}%`, checked: p === now, radio: true, note: p === disp ? t('menu.scale.display', lang) : null,
      title: p === disp ? t('menu.scale.displayTitle', lang, { p }) : null,
      action: { type: 'scale', target, percent: p },
    })),
  ];
}

/**
 * Resource replies read the way SSP reads them (UI §2.11): `hidden(...ids)` = the first id with an answer says 0
 * (greys the item; no answer = enabled); `caption(ids, key)` = the first non-empty caption of `ids` (legacy names
 * first; the ghost's text, lang '') or ours in `lang`.
 */
function replies(res, lang) {
  const get = id => (res instanceof Map ? res.get(id) : res ? res[id] : undefined);
  const hidden = (...ids) => {
    for (const id of ids) {
      const v = nonEmpty(get(id));
      if (v !== null) return v.trim() === '0';
    }
    return false;
  };
  const caption = (ids, key, params = null) => {
    for (const id of ids) {
      const g = nonEmpty(get(id));
      if (g !== null) return { label: g, lang: '' };
    }
    return { label: t(key, lang, params) };
  };
  return { get, hidden, caption };
}

/**
 * Information ▸ (UI §2.11, SSP MENU 102): About Sumika (in SSP's About SSP slot), About this ghost (greyed without a
 * readme), Terms of this ghost (greyed without terms.*), Help (greyed: no help page), a separator, AI graph, Ghost
 * usage statistics, Output system information (greyed) [decision]. A ghost's caption replaces each; its visible 0
 * greys it.
 * @param {{readme?: boolean, terms?: boolean}} info what the ghost has (info.js infoFlags)
 * @param {Map|object} res resource replies
 * @param {string} [lang]
 */
export function infoItems(info, res, lang = 'en') {
  const { hidden, caption } = replies(res, lang);
  const i = info || {};
  const item = (id, key, action, greyed = false, legacy = null) => {
    const it = { kind: 'item', ...caption(legacy ? [legacy, `${id}.caption`] : [`${id}.caption`], key), disabled: greyed || hidden(`${id}.visible`) };
    if (action) it.action = action;
    return it;
  };
  return [
    item('firststaffbutton', 'menu.about', { type: 'about' }),
    item('readmebutton', 'menu.readme', { type: 'readme' }, !i.readme, 'readmebuttoncaption'),
    item('termsbutton', 'menu.terms', { type: 'terms' }, !i.terms),
    item('helpbutton', 'menu.help', null, true),
    { kind: 'sep' },
    item('aistatebutton', 'menu.aiGraph', null, true),
    item('rateofusebutton', 'menu.usage', null, true),
    item('systeminfobutton', 'menu.sysinfo', null, true),
  ];
}

/**
 * Build the model of the menu `scope` owns (the shown menu's character: askMenu decides whether a click opens one, and
 * whose, before) from resource replies (Map id -> string|null).
 * Item: {kind:'item'|'sub'|'sep', label, action?, items?, disabled?, checked?, radio?, toggle?, dot?, note?, title?,
 * lang?} (lang: the label's lang attribute when it is not in the UI language; '' = the ghost's text, language unknown;
 * checked: a menuitemcheckbox with `toggle`, else a menuitemradio; its mark is SSP's dot with `radio` or `dot` (SSP's
 * command ids 6000–59999), else the tick, UI §2.3).
 * Order (UI §2.1 / §2.11, SSP MENU 102; MENU 128 for scope ≥ 1): see ssp-ui.md §2.11. `*.visible` 0 greys an item
 * (it stays in place); an empty site list greys its submenu; enable level ≥ 2 (minimized, induction) greys the
 * site lists, the scaling, Change ghost, Shell, Clothes/Dressup and Balloon submenus, level 3 (passive) also Iconify
 * [disasm GetEnableState]; Call ghost ▸ is not in that list [disasm, tentative]. There is no Network update or
 * Uninstall [decision].
 * @param {object} [o]
 * @param {object[]|null} [o.ghosts] the site's ghosts for Change ghost ▸ (ghostItems); none: no submenu
 * @param {object[]|null} [o.calls] the site's ghosts for Call ghost ▸ (callItems); none: no submenu (one ghost at most)
 * @param {{shell:number|null, balloon:number|null, dpr:number, fit?:{shell:number|null, balloon:number|null}}|null} [o.scaling]
 *   Shell / Balloon scaling ▸ (UserScaling.info(); `fit` on phones only); none: no submenus
 * @param {string} [o.lang] the UI language of the runtime's own captions ('en' | 'ja', UI §2.10)
 * @param {string|null} [o.languagePref] the stored language choice for Language ▸; none: no Language ▸
 * @param {object[]|null} [o.shells] Shell ▸ ({id, name, current}; shellItems); none: no submenu
 * @param {{top, all}|null} [o.balloons] Balloon ▸ (balloonItems); none: no submenu
 * @param {object|null} [o.dressup] Clothes/Dressup ▸ (Stage.dressupMenu(scope): {mode, enabled, entries}); none: no submenu
 * @param {number} [o.dressupScope] whose parts `dressup` lists, on each part's action (default `scope`; another
 *   character's in a redirected menu: bindScopeOf, UI §2.1 notes)
 * @param {{readme?: boolean, terms?: boolean}|null} [o.info] Information ▸; none: no submenu
 * @param {number} [o.enableLevel] 0 | 2 | 3 (EventLoop.enableLevel)
 * @param {boolean} [o.devFunctions] Utilities ▸ Reset passive mode
 * @param {boolean} [o.carry] Move character window (the stage can carry a character)
 * @param {boolean} [o.preferences] Options ▸ Preferences… (the page has the Preferences box, UI §2.13)
 * @param {{part?: (thumbnail:string) => string[], banner?: (banner:string) => string[]}|null} [o.thumbs] how a dress-up
 *   part's and a site row's thumbnails are found (UI §2.14), on the rows as `thumbs` functions; none: those rows have none
 */
export function buildMenuModel(scope, res, {
  ghosts = null, calls = null, scaling = null, lang = 'en', languagePref = null, shells = null, balloons = null,
  dressup = null, dressupScope = scope, info = null, enableLevel = 0, devFunctions = false, carry = false, preferences = false,
  thumbs = null,
} = {}) {
  const { get, hidden, caption } = replies(res, lang);
  const p = scopePrefix(scope);
  const level = Number(enableLevel) || 0;
  const busy = level >= 2;
  const siteItems = (list, kind) => list.map((s, index) => (s.separator ? { kind: 'sep' } : {
    kind: 'item',
    label: esc(s.title),
    lang: '',
    disabled: !s.url,
    action: { type: 'site', kind, title: s.title, url: s.url, banner: s.banner, index },
    // its banner, looked up when the row is selected (UI §2.14)
    ...(s.banner && thumbs && typeof thumbs.banner === 'function' ? { thumbs: () => thumbs.banner(s.banner) } : {}),
  }));
  // Recommendations ▸ / Portal site ▸: greyed when the list is empty [disasm]
  const siteSub = (visibleId, captionIds, listId, kind, key) => {
    const list = parseSiteList(get(listId));
    const any = list.some(s => !s.separator);
    return { kind: 'sub', ...caption(captionIds, key), items: any ? siteItems(list, kind) : [], disabled: !any || busy || hidden(visibleId) };
  };
  const dressupSub = () => ({
    kind: 'sub', ...caption(['dressuprootbutton.caption'], 'menu.dressup'),
    items: [
      { kind: 'item', ...caption(['dressupexplorerbutton.caption'], 'menu.dressupExplorer'), disabled: true },   // no Explorer [decision]
      { kind: 'sep' },
      // the bind scope's parts [disasm 2.9.10 UpdateBindMenu 0x41ede8]; the root greyed by the owner's (`enabled`,
      // ModifyMenuWithTable 0x41c975..0x41ca01)
      ...dressupItems(dressup, dressupScope, thumbs),
    ],
    disabled: !dressup.enabled || busy || hidden('dressuprootbutton.visible'),
  });
  // SSP inserts it at run time with a separator on each side [disasm InitWndMenu]
  const charMove = () => ({ kind: 'item', ...caption(['charmovebutton.caption'], 'menu.charMove'), disabled: hidden('charmovebutton.visible'), action: { type: 'carry' } });
  // SSP's abbreviated menu (MENU 128, UI §2.2) words Close without an access key: "Close" / "終了" (Ctrl+W only)
  const close = () => ({ kind: 'item', ...caption(['closebutton.caption'], scope === 0 ? 'menu.close' : 'menu.closeSub'), disabled: hidden('closebutton.visible'), action: { type: 'close' } });
  const quit = () => ({ kind: 'item', ...caption(['quitbutton.caption'], 'menu.quit'), disabled: hidden('quitbutton.visible'), action: { type: 'quit' } });
  const items = [];
  const sep = () => items.push({ kind: 'sep' });

  if (scope !== 0) {
    items.push(siteSub(`${p}.recommendrootbutton.visible`, [`${p}.recommendbuttoncaption`, `${p}.recommendrootbutton.caption`], `${p}.recommendsites`, 'recommend', 'menu.recommend'));
    if (dressup) items.push(dressupSub());
    sep();
    if (carry) { items.push(charMove()); sep(); }
    items.push(close(), quit());
    return tidySeparators(items);
  }

  items.push(siteSub('recommendrootbutton.visible', ['sakura.recommendbuttoncaption', 'recommendrootbutton.caption'], 'sakura.recommendsites', 'recommend', 'menu.recommend'));
  items.push(siteSub('portalrootbutton.visible', ['sakura.portalbuttoncaption', 'portalrootbutton.caption'], 'sakura.portalsites', 'portal', 'menu.portal'));
  // SSP's Network update and Uninstall come next: nothing is updated or installed in a visitor's browser, so there
  // are none [decision]
  sep();
  // (RSS/Headlines ▸, Plugins ▸, Check mail ▸: left out) Shell scaling ▸, Balloon scaling ▸, Utilities ▸ (UI §2.1 #8–10)
  if (scaling) {
    const scaleSub = (target, root, other, key) => {
      const own = nonEmpty(get(`${other}.caption`));
      items.push({ kind: 'sub', ...caption([`${root}.caption`], key), disabled: busy || hidden(`${root}.visible`),
        items: scaleItems(target, scaling[target], scaling.dpr, { other: own, otherLang: '', otherVisible: !hidden(`${other}.visible`), lang,
          fit: scaling.fit ? scaling.fit[target] : null }) });
    };
    scaleSub('shell', 'shellscalerootbutton', 'shellscaleotherbutton', 'menu.shellScale');
    scaleSub('balloon', 'balloonscalerootbutton', 'balloonscaleotherbutton', 'menu.balloonScale');
  }
  const utilities = [];
  if (devFunctions) {
    // SSP shows it only with "Enable functions for developers"; ours with ?sumika-debug [decision]
    utilities.push({ kind: 'item', ...caption(['leavepassivebutton.caption'], 'menu.leavePassive'), disabled: hidden('leavepassivebutton.visible'), action: { type: 'leavepassive' } });
    utilities.push({ kind: 'sep' });
  }
  utilities.push({ kind: 'item', ...caption(['resettodefaultbutton.caption'], 'menu.resetPosition'), disabled: hidden('resettodefaultbutton.visible'), action: { type: 'reset' } });
  items.push({ kind: 'sub', ...caption(['utilityrootbutton.caption'], 'menu.utilities'), disabled: hidden('utilityrootbutton.visible'), items: utilities });
  // Options ▸ with only Preferences… (UI §2.13): SSP's other items have no browser meaning [decision]; not greyed by the
  // enable level (not in GetEnableState's list, UI §2.11) [infer]
  if (preferences) {
    items.push({
      kind: 'sub', ...caption(['configurationrootbutton.caption'], 'menu.options'), disabled: hidden('configurationrootbutton.visible'),
      items: [{ kind: 'item', ...caption(['configurationbutton.caption'], 'menu.preferences'), disabled: hidden('configurationbutton.visible'), action: { type: 'preferences' } }],
    });
  }
  // ----, Change ghost ▸, Call ghost ▸, Shell ▸, Clothes/Dressup ▸, Balloon ▸, (History ▸)
  sep();
  if (ghosts && ghosts.length) {
    items.push({ kind: 'sub', ...caption(['ghostrootbutton.caption'], 'menu.changeGhost'), disabled: busy || hidden('ghostrootbutton.visible'), items: ghostItems(ghosts, lang) });
  }
  // MENU 102 position 15; not greyed by the enable level (ModifyPopupMenuEnableStateSakura skips it) [disasm, tentative]
  if (Array.isArray(calls)) {
    items.push({ kind: 'sub', ...caption(['callghostrootbutton.caption'], 'menu.callGhost'), disabled: hidden('callghostrootbutton.visible'), items: callItems(calls, lang) });
  }
  if (shells) items.push({ kind: 'sub', ...caption(['shellrootbutton.caption'], 'menu.shell'), disabled: busy || hidden('shellrootbutton.visible'), items: shellItems(shells) });
  if (dressup) items.push(dressupSub());
  if (balloons) items.push({ kind: 'sub', ...caption(['balloonrootbutton.caption'], 'menu.balloon'), disabled: busy || hidden('balloonrootbutton.visible'), items: balloonItems(balloons) });
  // ----, Information ▸, Language ▸, Iconify
  sep();
  if (info) items.push({ kind: 'sub', ...caption(['inforootbutton.caption'], 'menu.info'), disabled: hidden('inforootbutton.visible'), items: infoItems(info, res, lang) });
  // Language ▸ has no caption or visible resource: "[変更不可]Languageの名称" [UKADOC:res], 'Language' in every language
  if (languagePref) items.push({ kind: 'sub', label: t('menu.language', lang), lang: 'en', items: languageItems(lang, languagePref) });
  items.push({ kind: 'item', ...caption(['hidebutton.caption'], 'menu.iconify'), disabled: level >= 3 || hidden('hidebutton.visible'), action: { type: 'iconify' } });
  sep();
  if (carry) { items.push(charMove()); sep(); }
  items.push(close(), quit());
  return tidySeparators(items);
}

function tidySeparators(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'sub') it.items = tidySeparators(it.items);
    if (it.kind === 'sep' && (!out.length || out[out.length - 1].kind === 'sep')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === 'sep') out.pop();
  return out;
}

const rgbOf = (d, key) => {
  const c = ['r', 'g', 'b'].map(k => d.get(`${key}.${k}`));
  if (c.some(v => v == null || v === '' || !Number.isFinite(Number(v)))) return null;
  return `rgb(${c.map(v => Math.max(0, Math.min(255, Number(v) | 0))).join(',')})`;
};
/** 'rgb(r,g,b)' -> [r, g, b] (null for anything else) */
const rgbParts = s => {
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(s || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
};

/**
 * A `menu.*.alignment` value read as SSP's SPUtils::GetAlignFlag reads it [disasm 0x789370]: substrings in any case,
 * 'right', else 'center', else left; 'bottom', else top ('lefttop', 'Center', 'bottom' …).
 * @returns {string} 'left top' … 'right bottom'
 */
export function alignFlag(value) {
  const s = String(value ?? '').toLowerCase();
  return `${s.includes('right') ? 'right' : s.includes('center') ? 'center' : 'left'} ${s.includes('bottom') ? 'bottom' : 'top'}`;
}

/** SSP copies a face name into LOGFONTW.lfFaceName with wcslcpy(…, 32): 31 UTF-16 units at most [disasm] */
const FACE_MAX = 31;

/**
 * Menu look from the descripts (UI §2.3). SSP reads every `menu.*` key of the ghost's descript.txt first, then the
 * shell's on top, key by key [disasm SPGhost::LoadShell → LoadDescriptOverride → SPMenu::LoadFromDescript], so the
 * shell's value wins. null members: SSP's defaults (menuColors). fontName / fontHeight: `menu.font.name` (cut to 31
 * characters) and `menu.font.height` (atol; 0 or none = the system menu font's; a height in device px, its sign
 * ignored: lfHeight = −|v|) [disasm SPMenu::CalcMenuTextHeightAndCreateFont]. Alignments as GetAlignFlag reads them
 * (alignFlag); without a key SSP's flags stay 0: the background and foreground then sit left top, and the sidebar is
 * drawn bottom-aligned (DrawItem tests the 'top' bit) while its fill is still its bottom pixel (SetValues tests the
 * 'bottom' bit) [disasm 0x696081, 0x695551]: `sidebarTopEdge` says whether the fill is the image's top pixel.
 * `odm`: the SHIORI's answers (odmPass's `keys`) on top of both, key by key, as GetODMFromShiori writes them into the
 * same fields [disasm 2.9.10 0x623730]; its image names are not in it (odmPass keeps them apart).
 * @param {Map<string,string>|object|null} descript the shell's descript
 * @param {Map<string,string>|object|null} [ghostDescript] the ghost's (ghost/master/descript.txt)
 * @param {Map<string,string>|object|null} [odm] the SHIORI's menu.* answers
 */
export function menuLook(descript, ghostDescript = null, odm = null) {
  const toMap = x => (x instanceof Map ? x : new Map(Object.entries(x || {})));
  const d = new Map(toMap(ghostDescript));
  for (const [k, v] of toMap(descript)) d.set(k, v);
  for (const [k, v] of toMap(odm)) d.set(k, v);
  const align = k => (d.has(k) ? alignFlag(d.get(k)) : null);
  const side = align('menu.sidebar.alignment');
  const face = String(d.get('menu.font.name') ?? '').trim();
  const height = parseInt(String(d.get('menu.font.height') ?? '').trim(), 10);
  return {
    background: d.get('menu.background.bitmap.filename') || null,
    foreground: d.get('menu.foreground.bitmap.filename') || null,
    sidebar: d.get('menu.sidebar.bitmap.filename') || null,
    backgroundAlign: align('menu.background.alignment') || 'left top',
    foregroundAlign: align('menu.foreground.alignment') || 'left top',
    sidebarAlign: side && side.endsWith(' top') ? 'top' : 'bottom',
    sidebarTopEdge: !!side && side.endsWith(' bottom'),
    text: rgbOf(d, 'menu.background.font.color'),
    hoverText: rgbOf(d, 'menu.foreground.font.color'),
    disabledText: rgbOf(d, 'menu.disable.font.color'),
    separator: rgbOf(d, 'menu.separator.color'),
    backgroundColor: rgbOf(d, 'menu.background.color'),
    foregroundColor: rgbOf(d, 'menu.foreground.color'),
    sidebarColor: rgbOf(d, 'menu.sidebar.color'),
    frame: rgbOf(d, 'menu.frame.color'),
    fontName: face ? face.slice(0, FACE_MAX) : null,
    fontHeight: Number.isFinite(height) && height !== 0 ? Math.abs(height) : null,
  };
}

// ---- the SHIORI's menu look (UI §2.3) [disasm 2.9.10 SPGhost::GetODMFromShiori 0x623730]: the only menu.* ids ssp.exe
// ever asks a SHIORI for, each through GetString → GetStringShiori (no cache: every ask is a request); never
// menu.font.name / menu.font.height nor a colour without its .r / .g / .b.

const rgbIds = k => ['r', 'g', 'b'].map(c => `menu.${k}.${c}`);
/** asked first at every pass, background then foreground [disasm 0x623802, 0x623917] */
export const ODM_NAME_IDS = Object.freeze(['menu.background.bitmap.filename', 'menu.foreground.bitmap.filename']);
/** asked only when both names came back [disasm 0x623a18; a missing foreground jumps past it, 0x623925] */
export const ODM_SIDEBAR_ID = 'menu.sidebar.bitmap.filename';
/** the fill colours, always asked after the names [disasm 0x623b21..0x623c35] */
export const ODM_FILL_IDS = Object.freeze([...rgbIds('background.color'), ...rgbIds('foreground.color')]);
/** the other 26, in SSP's order, only when the pass is complete [disasm 0x623c9d..0x62412a] */
export const ODM_REST_IDS = Object.freeze([
  ...rgbIds('sidebar.color'), 'menu.sidebar.width', 'menu.sidebar.text',
  ...rgbIds('background.font.color'), ...rgbIds('foreground.font.color'), ...rgbIds('sidebar.font.color'),
  ...rgbIds('disable.font.color'), ...rgbIds('separator.color'), ...rgbIds('frame.color'),
  'menu.background.alignment', 'menu.foreground.alignment', 'menu.sidebar.alignment',
]);
/** SPMenu::InitMenuProp's image names, before the descripts' [disasm 2.9.10 0x696687..0x6966b8] */
export const ODM_DEFAULT_NAMES = Object.freeze({ bg: 'menu_background', fg: 'menu_foreground', side: 'menu_sidebar' });
const ODM_SLOTS = Object.freeze(['bg', 'fg', 'side']);

/**
 * A SHIORI's image name as GetODMFromShiori stores it [disasm 0x623832..0x6238af]: trailing U+0020 cut (tabs and
 * leading spaces stay); then, at 5 characters or more, a '.' 4 from the end removes 4, else a '.' 5 from the end
 * removes 5 ('menu\menu_background_1.png' → 'menu\menu_background_1'; '.bmp', '.jpeg' go too).
 */
export function odmStem(value) {
  let s = String(value ?? '');
  while (s.endsWith(' ')) s = s.slice(0, -1);
  if (s.length >= 5) {
    if (s[s.length - 4] === '.') s = s.slice(0, -4);
    else if (s[s.length - 5] === '.') s = s.slice(0, -5);
  }
  return s;
}

/**
 * A descript's image name as LoadFromDescript stores it (SPUtils::RemoveExtensionFromFileName [disasm 0x7892b0]): cut
 * from the last '.' when it comes after the last '\' or '/'.
 */
export function descriptStem(name) {
  const s = String(name ?? '');
  const dot = s.lastIndexOf('.');
  return dot >= 0 && dot > Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')) ? s.slice(0, dot) : s;
}

/**
 * Where a SHIORI-named image is looked for: LoadGhostCore gives the menu the search paths [the shell folder,
 * ghost/master/] [disasm 0x6215df..0x6215fd], and LoadSurfaceDataFromName tries each path + stem + '.png', whatever
 * extension was written, the first that decodes winning [disasm 0x698d06..0x698d88]. A '!' stem is SSP's own data
 * folder (FindSystemFileFromPartialDir [disasm 0x698bf9]): Sumika ships none, so nothing [decision]. '\' and any case
 * are the files' lookup's (GhostFiles.resolve).
 * @param {string} stem odmStem
 * @param {string} [shellDir] e.g. 'shell/master/'
 * @returns {string[]} ghost-root paths in search order
 */
export function odmImagePaths(stem, shellDir = 'shell/master/') {
  const s = String(stem ?? '');
  if (!s || s.startsWith('!')) return [];
  const dir = String(shellDir ?? '');
  return [`${dir && !dir.endsWith('/') ? dir + '/' : dir}${s}.png`, `ghost/master/${s}.png`];
}

/**
 * One colour channel as SPColor::Set reads it [disasm SPColor_IsValidElement 0x5eba00, Set 0x5ebd80 / 0x5ebdd0]:
 * spaces or tabs, an optional sign, digits, an optional '%', spaces or tabs, nothing else; wtol ≥ 0; its low byte
 * (256 → 0). null: SSP leaves the colour as it was.
 */
export function colorChannel(value) {
  const s = String(value ?? '');
  if (!/^[ \t]*[+-]?\d+%?[ \t]*$/.test(s)) return null;
  const n = parseInt(s.replace(/^[ \t]+/, ''), 10);
  return n >= 0 ? n & 0xff : null;
}

/**
 * The SHIORI layer of a shell load (InitMenuProp, then LoadFromDescript's image names [disasm 0x6965c0, 0x6967a5]):
 * keys (the answers, menuLook's `odm`), names (each slot's stored stem: the descripts', else InitMenuProp's), paths (a
 * slot the SHIORI named: where its image is looked for, odmImagePaths; null: the descripts' image), loaded (the load
 * pass ran), complete (its result: later opens ask again, SSP's gate [disasm 0x6216f8]).
 * @param {object|null} [look] the descripts' menuLook
 */
export function odmState(look = null) {
  const L = look || {};
  const name = (v, d) => (v ? descriptStem(v) : d);
  return {
    keys: new Map(),
    names: { bg: name(L.background, ODM_DEFAULT_NAMES.bg), fg: name(L.foreground, ODM_DEFAULT_NAMES.fg), side: name(L.sidebar, ODM_DEFAULT_NAMES.side) },
    paths: { bg: null, fg: null, side: null },
    loaded: false,
    complete: false,
  };
}

/**
 * One GetODMFromShiori pass [disasm 2.9.10 0x623730..0x624180], in three batches:
 * 1. the two image names (ODM_NAME_IDS);
 * 2. the sidebar's name when both came back, then the fill colours (ODM_FILL_IDS);
 * 3. only when complete = both names came back, or the background's and the foreground's colour flags are set: the
 *    other 26 (ODM_REST_IDS).
 * An answer is a non-empty string (GetString's NULL for none or '' [disasm 0x64254d]); none keeps what was there (the
 * descripts' or an earlier answer), until the next shell load. A name's odmStem replaces its slot's stored name; with
 * `force` (a shell load) or a stem that differs (wcscmp) the slot is reloaded from it, one image (`reload`), an empty
 * stem keeping the old images [disasm 0x6238ba..0x6238ee, LoadMultipleMenuImage 0x69729e]. A colour channel goes
 * through SPColor (colorChannel; an invalid one is no answer and sets no flag); an alignment replaces the flags; width
 * and text are kept as answered.
 * @param {(ids: string[]) => Promise<Map<string, string|null>>} ask one batch of resource requests
 * @param {ReturnType<typeof odmState>} st written in place (keys, names)
 * @param {{force?: boolean, colourSet?: (which: 'background'|'foreground') => boolean|Promise<boolean>}} [o]
 *   colourSet: that colour's flag before this pass (set by a descript or an earlier answer and not cleared by its
 *   loaded image, SetValues [disasm 0x697723]); asked only when the names alone do not decide
 * @returns {Promise<{complete: boolean, reload: Set<'bg'|'fg'|'side'>, asked: string[]}>}
 */
export async function odmPass(ask, st, { force = false, colourSet = () => false } = {}) {
  const asked = [];
  const reload = new Set();
  const batch = async ids => {
    asked.push(...ids);
    let r = null;
    try { r = await ask(ids); } catch (e) { r = null; }
    return id => {
      const v = r && typeof r.get === 'function' ? r.get(id) : null;
      return v == null || v === '' ? null : String(v);
    };
  };
  const name = (slot, v) => {
    const stem = odmStem(v);
    if (!force && stem === st.names[slot]) return;
    st.names[slot] = stem;
    if (stem) reload.add(slot);
  };
  const colour = (get, id) => {
    const c = colorChannel(get(id));
    if (c === null) return false;
    st.keys.set(id, String(c));
    return true;
  };
  let get = await batch(ODM_NAME_IDS);
  const bg = get(ODM_NAME_IDS[0]);
  const fg = get(ODM_NAME_IDS[1]);
  if (bg !== null) name('bg', bg);
  if (fg !== null) name('fg', fg);
  const both = bg !== null && fg !== null;
  get = await batch([...(both ? [ODM_SIDEBAR_ID] : []), ...ODM_FILL_IDS]);
  if (both) { const side = get(ODM_SIDEBAR_ID); if (side !== null) name('side', side); }
  const set = { background: false, foreground: false };
  for (const id of ODM_FILL_IDS) if (colour(get, id)) set[id.startsWith('menu.background.') ? 'background' : 'foreground'] = true;
  const flag = async which => set[which] || !!(await colourSet(which));
  const complete = both || ((await flag('background')) && (await flag('foreground')));
  if (!complete) return { complete, reload, asked };
  get = await batch(ODM_REST_IDS);
  for (const id of ODM_REST_IDS) {
    if (/\.[rgb]$/.test(id)) { colour(get, id); continue; }
    const v = get(id);
    if (v !== null) st.keys.set(id, v);
  }
  return { complete, reload, asked };
}

/**
 * Windows' system colours SSP starts from (InitMenuProp: COLOR_MENU, COLOR_MENUTEXT, COLOR_HIGHLIGHT,
 * COLOR_HIGHLIGHTTEXT) [disasm], with Windows 10/11's light-theme values [win32].
 */
const SYS = Object.freeze({ menu: 'rgb(240,240,240)', menuText: 'rgb(0,0,0)', highlight: 'rgb(0,120,215)', highlightText: 'rgb(255,255,255)' });

/**
 * SSP's own look, `data/ssp_default_odm.txt` [res SSP-ODM]: its colours, and its 1 × 1 background (white) and
 * foreground (black) images as colours. Its sidebar image is not copied (UI §2.3).
 */
export const SSP_DEFAULT_ODM = Object.freeze({
  text: 'rgb(0,0,0)', hoverText: 'rgb(255,255,255)', disabledText: 'rgb(217,217,217)', separator: 'rgb(160,160,160)',
  background: 'rgb(255,255,255)', foreground: 'rgb(0,0,0)',
});

/**
 * Whether SSP takes the shell's look (UI §2.3) [disasm SPMenu::LoadSurface 0x69503c]: background and foreground
 * images that both load, or `menu.background.color` and `menu.foreground.color` whose images did not load, or
 * `menu.sidebar.color` whose image did not load. A colour's flag counts only then: SetValues (PreparePopup, before the
 * test) replaces a colour with its loaded image's edge pixel and clears the flag [disasm 0x695598].
 * @param {object|null} look menuLook()
 * @param {{bg?: object|null, fg?: object|null, side?: object|null}} [images] the loaded images (probeImage)
 */
export function menuAccepted(look, images = {}) {
  const L = look || menuLook(null);
  const { bg = null, fg = null, side = null } = images || {};
  return !!((bg && fg) || (L.backgroundColor && !bg && L.foregroundColor && !fg) || (L.sidebarColor && !side));
}

/**
 * The images a menu is drawn with when SSP does not take the shell's look (menuAccepted): none, and SSP's own colours
 * (menuColors).
 */
export const SSP_LOOK = Object.freeze({ bg: null, fg: null, side: null, ssp: true });

/**
 * The colours a menu is drawn in (UI §2.3) [disasm SPMenu::InitMenuProp, LoadSurface, SetValues; SPGhost::LoadGhostCore]:
 * - a look SSP accepts (menuAccepted): its colours; the text black (COLOR_MENUTEXT) and the hot text white by default;
 *   the fill behind the rows the background image's edge pixel (SetValues), else `menu.background.color`, else
 *   COLOR_MENU, and behind the hot row the foreground image's, else `menu.foreground.color`, else COLOR_HIGHLIGHT (so a
 *   look taken for its `menu.sidebar.color` alone gets Windows' colours); the disabled colour (2 × fill + text) / 3 per
 *   channel and the separator the text colour unless the descript sets them;
 * - any other look, and `images` = SSP_LOOK: SSP draws its own default menu instead (SSP_DEFAULT_ODM; `ssp: true`, the
 *   shell's images unused).
 * The frame is `menu.frame.color` in both, black by default. `accepted`: the look was taken at its shell's load
 * (Menu._popupImages: the descripts' or a complete SHIORI pass), so menuAccepted is not asked again. `loadDefaults`
 * ({disabled, separator}): the defaults LoadSurface computed at that load, before the SHIORI was asked [disasm 2.9.10
 * 0x6970d4..0x6970f0, 0x697121..0x69719c]; they stand when the look sets neither (a SHIORI text colour then moves
 * neither).
 * @param {object|null} look menuLook()
 * @param {{bg?: {edge?: string|null}|null, fg?: {edge?: string|null}|null, side?: object, ssp?: boolean}} [images]
 *   the loaded images (probeImage)
 * @param {{accepted?: boolean, loadDefaults?: {disabled?: string|null, separator?: string|null}|null}} [o]
 * @returns {{ssp: boolean, text: string, hotText: string, disabled: string, separator: string, bg: string, hotBg: string, frame: string}}
 */
export function menuColors(look, images = {}, { accepted = false, loadDefaults = null } = {}) {
  const L = look || menuLook(null);
  const bg = images && images.bg;
  const fg = images && images.fg;
  const frame = L.frame || 'rgb(0,0,0)';
  if ((images && images.ssp) || (!accepted && !menuAccepted(L, images))) {
    const o = SSP_DEFAULT_ODM;
    return { ssp: true, text: o.text, hotText: o.hoverText, disabled: o.disabledText, separator: o.separator, bg: o.background, hotBg: o.foreground, frame };
  }
  const fill = (bg && bg.edge) || L.backgroundColor || SYS.menu;
  const text = L.text || SYS.menuText;
  let disabled = L.disabledText || (loadDefaults && loadDefaults.disabled) || null;
  if (!disabled) {
    const f = rgbParts(fill) || [240, 240, 240];
    const t = rgbParts(text) || [0, 0, 0];
    disabled = `rgb(${f.map((v, i) => Math.trunc((2 * v + t[i]) / 3)).join(',')})`;
  }
  return {
    ssp: false, text, hotText: L.hoverText || SYS.highlightText, disabled,
    separator: L.separator || (loadDefaults && loadDefaults.separator) || text,
    bg: fill, hotBg: (fg && fg.edge) || L.foregroundColor || SYS.highlight, frame,
  };
}

// ---- metrics (UI §2.3) [disasm SPMenu::CalcMenuTextHeightAndCreateFont, GetMenuTextHeight, MeasureItem, DrawItem,
// DrawSubMenuArrow]: SSP is per-monitor DPI-aware and only its font follows the display; every other length is a
// constant in device pixels, the menu images are blitted 1:1. Here: n device px = n / devicePixelRatio CSS px.

/** SSP's "Vertical menu spacing" (ExtraMenuHeight): 2 device px above and below the text, by default [disasm] */
export const MENU_SPACING = 2;
/** the caption starts this far right of the sidebar, an accelerator ends this far left of the right edge [disasm] */
export const MENU_INSET = 16;
/** the gap before an accelerator (MeasureItem's + 8) [disasm] */
export const MENU_ACCEL_GAP = 8;
/** the check / radio column's centre, from the sidebar's right edge [disasm] */
const CHECK_X = 7;
/**
 * A menu opened by a touch (a long press, UI §9.6) gets a larger spacing, so its rows are at least this tall in CSS px
 * (WCAG 2.5.8's 24 px target); SSP has no touch [decision].
 */
export const MENU_TOUCH_ROW = 24;
/**
 * Segoe UI's design units (per 2048 em): winAscent and winDescent, and the advances of a–z A–Z together. Yu Gothic UI,
 * the Japanese Windows menu font, has the same numbers [font: segoeui.ttf, YuGothM.ttc].
 */
const SEGOE = Object.freeze({ upm: 2048, ascent: 2210, descent: 514, alphabet: 58880 });

/** Pixel art: rows of '#' with the origin at column `x0`, row `y0` -> [[x, y], …] */
const art = (rows, x0, y0) => rows.flatMap((r, y) => [...r].flatMap((c, x) => (c === '#' ? [[x - x0, y - y0]] : [])));
/**
 * The check mark, Polyline (cx−2, cy−1) → (cx, cy+1) → (cx+5, cy−4) with a 2-px geometric pen, square caps, miter
 * join [disasm], filled as GDI fills the measured arrow (a pixel whose top-left corner is inside) [infer].
 */
const TICK = art([
  '........#.',
  '.......###',
  '......###.',
  '.#...###..',
  '###.###...',
  '.#####....',
  '..###.....',
  '...#......',
], 3, 5);
/** The radio dot, Ellipse(cx−4, cy−4, cx+5, cy+5) with NULL_PEN (8 × 8) [disasm; infer: its pixels] */
const DOT = art([
  '..####..',
  '.######.',
  '########',
  '########',
  '########',
  '########',
  '.######.',
  '..####..',
], 4, 4);

/** n device px as a CSS length at `dpr` */
export function devicePx(n, dpr = currentDpr()) {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return `${Math.round((n / d) * 1e4) / 1e4 || 0}px`;
}

/**
 * The menu font's em height in device px (SSP's text height th): `menu.font.height` as given, never scaled
 * (lfHeight = −|v|) [disasm], else the system menu font, 9 pt at the window's DPI: MulDiv(9, 96 × dpr, 72) =
 * round(12 × dpr) [win32], which is 12 CSS px at every Windows display scale.
 * @param {number} dpr
 * @param {number|null} [fontHeight] menuLook().fontHeight
 */
export function menuTextHeight(dpr = currentDpr(), fontHeight = null) {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const h = Math.abs(Math.trunc(Number(fontHeight) || 0));
  return h || Math.max(1, Math.round(12 * d));
}

/**
 * The spacing (ExtraMenuHeight) a menu is drawn with, in device px: SSP's 2, or for a menu opened by a touch the least
 * that makes its rows MENU_TOUCH_ROW CSS px tall [decision].
 * @param {number} [dpr]
 * @param {number} [th] menuTextHeight
 * @param {boolean} [touch]
 */
export function menuSpacing(dpr = currentDpr(), th = menuTextHeight(dpr), touch = false) {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  if (!touch) return MENU_SPACING;
  return Math.max(MENU_SPACING, Math.ceil((Math.ceil(MENU_TOUCH_ROW * d - 1e-6) - th) / 2));
}

/**
 * Windows' own allowance after an owner-drawn popup item, in device px: 2 × the system menu font's average character
 * width, GdiGetCharDimensions' (⌊w / 26⌋ + 1) / 2 of the advance w of a–z A–Z [win32: Wine MENU_CalcItemSize]. The
 * font is Windows' own, never a descript's: Segoe UI at round(12 × dpr) px (SEGOE.alphabet): 14 / 16 / 20 / 24 / 26 at
 * 100 / 125 / 150 / 175 / 200 % [font: segoeui.ttf's hinted widths give the same; measured: 16 at 125 %].
 * @param {number} [dpr]
 */
export function menuExtraWidth(dpr = currentDpr()) {
  const w = Math.round((SEGOE.alphabet * menuTextHeight(dpr)) / SEGOE.upm);
  return 2 * ((Math.floor(w / 26) + 1) >> 1);
}

const leadings = new Map();

/**
 * The internal leading (tmInternalLeading) of the menu's primary font at an em of `th` device px: its ascent and
 * descent, each rounded to whole px (as GDI and Blink round them), less the em. Measured on a canvas
 * (fontBoundingBoxAscent / Descent of the first available font of `family`), else Segoe UI's: 4 / 5 / 6 / 7 / 8 at
 * 12 / 15 / 18 / 21 / 24 px [font]. Remembered per size and family.
 * @param {number} th
 * @param {string} [family] a CSS font-family list
 */
export function menuInternalLeading(th, family = MENU_FONTS) {
  const key = `${th}|${family}`;
  if (leadings.has(key)) return leadings.get(key);
  let il = Math.round((SEGOE.ascent * th) / SEGOE.upm) + Math.round((SEGOE.descent * th) / SEGOE.upm) - th;
  try {
    const c = typeof document !== 'undefined' && typeof document.createElement === 'function' ? document.createElement('canvas') : null;
    const g = c && typeof c.getContext === 'function' ? c.getContext('2d') : null;
    if (g && typeof g.measureText === 'function') {
      g.font = `${th}px ${family}`;
      const m = g.measureText('驫Aj');
      if (m && Number.isFinite(m.fontBoundingBoxAscent) && Number.isFinite(m.fontBoundingBoxDescent)) {
        il = Math.round(m.fontBoundingBoxAscent) + Math.round(m.fontBoundingBoxDescent) - th;
      }
    }
  } catch (e) { /* no canvas: Segoe UI's */ }
  leadings.set(key, il);
  return il;
}

/**
 * SSP's menu metrics at `dpr`, in device px [disasm]: th (menuTextHeight), row = th + 2 × spacing, separator =
 * 2 × spacing + 7 with its 1-px line at spacing + 3, insets 16, accelerator gap 8; cy = the check's and arrow's centre
 * row from the row top, spacing + ⌊(row − spacing) / 2⌋; the arrow (DrawSubMenuArrow): half-height a =
 * max(⌊3 th / 10⌋, 4), width w = max(⌊(10 a + 5) / 9⌋, 3), its left column 8 + ⌊w / 2⌋ left of the right edge.
 * Pixel lists (tick, dot: from the row's top-left pixel; arrow: from the row's top-right pixel) are what the menu draws
 * them with (pixelShadow). The arrow's rows are filled as GDI fills a polygon: n = ⌈w (a − |j|) / a⌉ pixels in row
 * cy + j, |j| < a [infer: matches the 5 × 7 arrow measured at 125 %]. extra: Windows' allowance (menuExtraWidth).
 * textShift (0 or 1): SSP puts the baseline at row top + spacing − ⌊IL / 2⌋ + ascent (IL = `leading`,
 * menuInternalLeading) [disasm DrawItem 0x696591]; Blink centres a line box of the row's height with
 * ⌊(row − A − D) / 2⌋ above the text (CalculateLeadingSpace), 1 px higher when IL is odd. Then the text's line is a
 * row less 1 px under a 1-px pad, which brings it to SSP's baseline [infer: Blink's layout code; 125 % and 175 % with
 * Segoe UI].
 * @param {number} [dpr]
 * @param {{fontHeight?: number|null, leading?: number|null, spacing?: number}} [o]
 */
export function menuMetrics(dpr = currentDpr(), { fontHeight = null, leading = null, spacing = MENU_SPACING } = {}) {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const s = Number.isFinite(spacing) ? Math.max(0, Math.trunc(spacing)) : MENU_SPACING;
  const th = menuTextHeight(d, fontHeight);
  const row = th + 2 * s;
  const cy = s + Math.floor((row - s) / 2);
  const a = Math.max(Math.floor((3 * th) / 10), 4);
  const w = Math.max(Math.floor((10 * a + 5) / 9), 3);
  const right = 8 + Math.floor(w / 2);
  const arrow = [];
  for (let j = 1 - a; j < a; j++) {
    const n = Math.ceil((w * (a - Math.abs(j))) / a);
    for (let i = 0; i < n; i++) arrow.push([i - right + 1, cy + j]);
  }
  return {
    dpr: d, th, spacing: s, row, separator: 2 * s + 7, separatorLine: s + 3, inset: MENU_INSET, accelGap: MENU_ACCEL_GAP, cy,
    extra: menuExtraWidth(d), textShift: Number.isInteger(leading) && Math.abs(leading) % 2 === 1 ? 1 : 0,
    arrow: { a, w, right, pixels: arrow },
    tick: TICK.map(([x, y]) => [CHECK_X + x, cy + y]),
    dot: DOT.map(([x, y]) => [CHECK_X + x, cy + y]),
  };
}

/** Device pixels [[x, y], …] from a 1-device-px element as a box-shadow list in its text colour ('none': no pixels). */
export function pixelShadow(pixels, dpr = currentDpr()) {
  if (!pixels || !pixels.length) return 'none';
  return pixels.map(([x, y]) => `${devicePx(x, dpr)} ${devicePx(y, dpr)} currentColor`).join(', ');
}

/**
 * The custom properties one menu element is drawn with (CSS below): metrics in CSS px, the pixel art, and the images'
 * sizes at one image pixel per device pixel (SSP blits them 1:1).
 * @param {ReturnType<typeof menuMetrics>} m
 * @param {{side?: {width, height}|null, bg?: {width, height}|null, fg?: {width, height}|null}} [images]
 */
export function menuVars(m, { side = null, bg = null, fg = null } = {}) {
  const px = n => devicePx(n, m.dpr);
  const size = i => (i ? `${px(i.width)} ${px(i.height)}` : 'auto');
  const shift = m.textShift || 0;
  return {
    '--smk-dp': px(1), '--smk-fs': px(m.th), '--smk-row': px(m.row), '--smk-sep-h': px(m.separator),
    '--smk-sep-y': px(m.separatorLine), '--smk-inset': px(m.inset), '--smk-gap': px(m.accelGap),
    '--smk-extra': px(m.extra ?? menuExtraWidth(m.dpr)), '--smk-text-lh': px(m.row - shift), '--smk-text-pt': px(shift),
    '--smk-tick': pixelShadow(m.tick, m.dpr), '--smk-dot': pixelShadow(m.dot, m.dpr), '--smk-arrow': pixelShadow(m.arrow.pixels, m.dpr),
    '--smk-side-w': px(side ? side.width : 0), '--smk-side-size': size(side), '--smk-bg-size': size(bg), '--smk-fg-size': size(fg),
  };
}

/**
 * The menu's fonts: the system menu font is Segoe UI on an English Windows, Yu Gothic UI on a Japanese one [win32].
 * GDI's font link for Segoe UI is Tahoma, then Meiryo UI (the `FontLink\SystemLink` registry key), so ssp.exe on an English
 * Windows draws kana in Meiryo UI; Tahoma has none, so it is left out [win32 registry; measured].
 */
export const MENU_FONTS = '"Segoe UI", "Meiryo UI", "Yu Gothic UI", system-ui, sans-serif';
export const MENU_FONTS_JA = '"Yu Gothic UI", "Meiryo UI", "Segoe UI", "Hiragino Sans", system-ui, sans-serif';

/**
 * The font-family of a menu whose descript names a face (`menu.font.name`): that face, then the usual fonts for the
 * glyphs it lacks (GDI's font linking does the same for SSP) [infer]; null without one.
 * @param {string|null} name menuLook().fontName
 * @param {string} [lang] the menu's language ('ja': the Japanese order)
 */
export function menuFontFamily(name, lang = 'en') {
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n) return null;
  return `"${n.replace(/["\\]/g, '\\$&')}", ${lang === 'ja' ? MENU_FONTS_JA : MENU_FONTS}`;
}

// The look of ssp.exe's owner-drawn menu (UI §2.3) [disasm]: the rows are the font's em + 2 × 2 device px with no
// padding above the first or below the last; 11-px separators whose 1-px line runs from the sidebar's edge to the right
// edge; the caption 16 px right of the sidebar, an accelerator or our note ending 16 px left of the right edge after
// an 8-px gap, plus Windows' own allowance after the caption (menuExtraWidth); the text's baseline where SSP's is
// (menuMetrics' textShift); the check, the radio dot and the submenu arrow drawn as SSP's pixels in the text colour
// (menuMetrics), kept in a Windows contrast theme, which turns box-shadow off (forced colors); the hot row's highlight
// over the whole row right of the sidebar, also on a greyed row (whose text stays greyed); a 1-device-px frame in
// menu.frame.color with Windows 11's small rounded corners and its shadow [measured: fit of 8.png]; no width minimum,
// at most 1000 device px; no open animation (SSP turns it off). The list is as tall as its rows (align-self), so a
// menu taller than the viewport knows its whole height (_imageAt). The lengths come from menuVars on each menu
// element (--smk-*); the fallbacks below are SSP's at 100 %. Phones (UI §9.11 F2, F5): at most the dynamic viewport
// tall, so Close and Quit stay above a browser bar (`dvh` is `vh` on desktop; older browsers keep the `vh` line); a
// menu opened by a touch (smk-touch) keeps its overscroll, which would scroll the page and close it.
const CSS = `
.smk-menu { position: fixed; z-index: ${Z_BASE + 200}; display: flex; box-sizing: border-box; min-width: 0;
  max-width: min(calc(1000 * var(--smk-dp, 1px)), calc(100vw - 16px)); max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px); overflow-y: auto;
  padding: 0; margin: 0; font-family: ${MENU_FONTS}; font-size: var(--smk-fs, 12px); line-height: var(--smk-row, 16px);
  font-weight: 400; font-style: normal; font-kerning: none; font-variant-ligatures: none; letter-spacing: 0;
  color: var(--smk-text, #000); background-color: var(--smk-bg, #fff); background-repeat: no-repeat;
  background-attachment: local; background-size: var(--smk-bg-size, auto);
  border: var(--smk-dp, 1px) solid var(--smk-frame, #000); border-radius: 4px; box-shadow: 0 11px 10px -2px rgba(0,0,0,.1);
  user-select: none; -webkit-user-select: none; outline: none; pointer-events: auto; }
.smk-menu.smk-touch { overscroll-behavior: contain; }
.smk-menu:lang(ja) { font-family: ${MENU_FONTS_JA}; }
.smk-menu .smk-side { flex: none; width: var(--smk-side-w, 0); background-repeat: no-repeat; background-size: var(--smk-side-size, auto); }
.smk-menu .smk-rows { flex: 1; align-self: flex-start; padding: 0; min-width: 0; }
.smk-menu .smk-row { position: relative; display: flex; align-items: center; box-sizing: border-box; height: var(--smk-row, 16px);
  gap: var(--smk-gap, 8px); padding: 0 var(--smk-inset, 16px); white-space: nowrap; cursor: default;
  background-repeat: no-repeat; border-radius: 0; }
.smk-menu .smk-row .smk-check { position: absolute; left: 0; top: 0; width: var(--smk-dp, 1px); height: var(--smk-dp, 1px); box-shadow: var(--smk-tick, none); }
.smk-menu .smk-row .smk-check.smk-bullet { box-shadow: var(--smk-dot, none); }
.smk-menu .smk-row .smk-arrow { position: absolute; right: 0; top: 0; width: var(--smk-dp, 1px); height: var(--smk-dp, 1px); box-shadow: var(--smk-arrow, none); }
.smk-menu .smk-row .smk-label { flex: 1; margin-right: var(--smk-extra, 14px); overflow: hidden; text-overflow: ellipsis; }
.smk-menu .smk-row .smk-note { flex: none; }
.smk-menu .smk-row .smk-accel { flex: none; }
.smk-menu .smk-row .smk-label, .smk-menu .smk-row .smk-note, .smk-menu .smk-row .smk-accel {
  line-height: var(--smk-text-lh, var(--smk-row, 16px)); padding-top: var(--smk-text-pt, 0); }
.smk-menu .smk-row:focus { outline: none; }
.smk-menu .smk-row[aria-disabled="true"] { color: var(--smk-disabled, rgb(217,217,217)); }
.smk-menu .smk-row.smk-hot { background-color: var(--smk-hot-bg, #000); background-size: var(--smk-fg-size, auto); }
.smk-menu .smk-row.smk-hot:not([aria-disabled="true"]) { color: var(--smk-hot-text, #fff); }
.smk-menu .smk-sep { height: var(--smk-sep-h, 11px); background: linear-gradient(var(--smk-sep, rgb(160,160,160)), var(--smk-sep, rgb(160,160,160)))
  0 var(--smk-sep-y, 5px) / 100% var(--smk-dp, 1px) no-repeat; }
.smk-menu u { text-decoration: underline; text-decoration-thickness: var(--smk-dp, 1px); text-underline-offset: var(--smk-dp, 1px); }
@media (forced-colors: active) {
  .smk-menu .smk-row .smk-check, .smk-menu .smk-row .smk-arrow { forced-color-adjust: none; }
  .smk-menu .smk-sep { forced-color-adjust: none; --smk-sep: CanvasText; }
}
`;

/**
 * Load an image and read its size and the pixel SSP extends where the image does not reach: the left column's bottom
 * pixel, the top one when its alignment has the 'bottom' flag (`bottomAligned`; a sidebar without an alignment key has
 * neither flag, menuLook) [disasm SPMenu::SetValues 0x695551].
 */
export function probeImage(url, bottomAligned = false, cors = crossOrigin(url)) {
  return new Promise(resolve => {
    if (typeof Image === 'undefined' || !url) { resolve(null); return; }
    const img = new Image();
    // another origin's pixels are readable only with CORS (the runtime host's ACAO); refused: once more
    // without, for the size alone (no edge colour)
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => {
      let edge = null;
      try {
        const c = document.createElement('canvas');
        c.width = 1;
        c.height = 1;
        const g = c.getContext('2d');
        g.drawImage(img, 0, bottomAligned ? 0 : img.naturalHeight - 1, 1, 1, 0, 0, 1, 1);
        const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
        edge = `rgb(${r},${gg},${b})`;
      } catch (e) { /* tainted or no canvas */ }
      resolve({ url, width: img.naturalWidth, height: img.naturalHeight, edge });
    };
    img.onerror = () => { if (cors) probeImage(url, bottomAligned, false).then(resolve); else resolve(null); };
    img.src = url;
  });
}

/** `url` is on another origin than the page (probeImage asks for CORS then) */
function crossOrigin(url) {
  try {
    return typeof location !== 'undefined' && new URL(url, location.href).origin !== location.origin;
  } catch (e) {
    return false;
  }
}

const NO_IMAGES = Object.freeze({ bg: null, fg: null, side: null });

/** which edge each slot's fill is read from (probeImage's `bottomAligned`), by the look's alignment flags now */
const edgeFlags = L => ({ bg: / bottom$/.test(L.backgroundAlign), fg: / bottom$/.test(L.foregroundAlign), side: !!L.sidebarTopEdge });

/**
 * The cap on each batch of the load pass (Menu.loadShioriLook): ssp.exe waits for its SHIORI as long as it takes, and an
 * answer missed at load would leave the ghost without its skin until its next shell load (the gate) [decision].
 */
export const ODM_LOAD_MS = 5000;

/** ?sumika-debug in the page URL: our stand-in for SSP's "Enable functions for developers" (UI §2.11) */
function debugPage() {
  try { return typeof location !== 'undefined' && /[?&]sumika-debug\b/.test(location.search); } catch (e) { return false; }
}

export class Menu {
  /**
   * @param {object} o
   * @param {object} [o.host]   EventLoop: resources() (captions, and the SHIORI's menu look: loadShioriLook),
   *   send(), playScript(), minimize(), close(), quitAll(), changeGhost(), callGhost(), changeShell(), changeBalloon(),
   *   toggleDressup(), setOption(), enableLevel
   * @param {object} [o.stage]  Stage: resetPositions(), shell.descript, dressupMenu(scope), carry(scope)
   * @param {object} [o.files]  GhostFiles of the ghost root (menu images)
   * @param {string} [o.shellDir] e.g. 'shell/master/'
   * @param {() => object[]} [o.ghosts] the site's ghosts for Change ghost ▸ ({id, name, current, note, needs,
   *   elsewhere}; ghostItems)
   * @param {() => object[]|null} [o.calls] the site's ghosts for Call ghost ▸ ({id, name, current, note, needs,
   *   elsewhere, full}; callItems); none, or null from it: no Call ghost ▸ (a site of one ghost at a time)
   * @param {object} [o.scaling] core/scaling.js UserScaling (info(), set(target, percent), askOther(target, scope))
   *   for Shell scaling ▸ and Balloon scaling ▸; none: no such submenus
   * @param {object} [o.language] core/language.js UiLanguage (lang, pref, set(pref), 'change'): the captions' language
   *   and Language ▸; none: English captions and no Language ▸
   * @param {() => object[]} [o.shells] Shell ▸ entries ({id, name, current}, menu order); none: no Shell ▸
   * @param {() => {top: object[], all: object[]}} [o.balloons] Balloon ▸ entries; none: no Balloon ▸
   * @param {() => {sources: {kind:'ghost'|'shell'|'balloon', name, files, descript}[], version?, engines?}} [o.info]
   *   what Information ▸ shows (ui/info.js); none: no Information ▸
   * @param {boolean} [o.devFunctions] Utilities ▸ Reset passive mode (default: ?sumika-debug in the page URL)
   * @param {Map<string,string>|null} [o.ghostDescript] the ghost's descript.txt: its `menu.*` keys under the shell's
   *   (menuLook; UI §2.3 lists `menu.font.name` / `menu.font.height` as ghost descript keys)
   * @param {() => void} [o.preferences] Options ▸ Preferences…: opens the Preferences box (the Site's, UI §2.13);
   *   none: no Options ▸
   * @param {import('./thumbnail.js').MenuThumbnail|null} [o.thumbnail] the thumbnail window the selected ghost row
   *   shows in (UI §2.14; default the page's one when a document exists); null: none
   */
  constructor({
    host = null, stage = null, files = null, shellDir = 'shell/master/', ghosts = null, calls = null, scaling = null,
    language = null, shells = null, balloons = null, info = null, devFunctions = debugPage(), ghostDescript = null,
    preferences = null, thumbnail = typeof document !== 'undefined' ? sharedThumbnail() : null,
  } = {}) {
    this.host = host;
    this.stage = stage;
    this.files = files;
    this.ghostDescript = ghostDescript;
    this.ghosts = typeof ghosts === 'function' ? ghosts : null;
    this.calls = typeof calls === 'function' ? calls : null;
    this.shells = typeof shells === 'function' ? shells : null;
    this.balloons = typeof balloons === 'function' ? balloons : null;
    this.info = typeof info === 'function' ? info : null;
    this.preferences = typeof preferences === 'function' ? preferences : null;
    this.devFunctions = !!devFunctions;
    this.scaling = scaling && typeof scaling.info === 'function' ? scaling : null;
    this.language = language && typeof language.set === 'function' ? language : null;
    this.shellDir = shellDir.endsWith('/') ? shellDir : shellDir + '/';
    this.el = null;
    this.subs = [];               // open submenus, outermost first; each one's __parentRow is a row one level up
    this._timers = [];            // per level: the pending open/close of the level below
    this.scope = 0;               // the open menu's character (its owner: popupmenu.type, UI §2.1 notes)
    this.clicked = 0;             // the character whose click opened it (R2 of its Close / Quit)
    this.token = 0;
    this.prevFocus = null;
    this._off = null;
    this._at = null;              // where the open menu was opened ({scope, x, y, device?}): a language change redraws it there
    this._touch = false;          // the open menu was opened by a touch: MENU_TOUCH_ROW rows (menuSpacing)
    this.look = null;             // the descripts' look with the SHIORI's answers on top (menuLook)
    this.images = null;           // the descripts' images (a promise of {bg, fg, side})
    this._lastImages = NO_IMAGES; // the images the open menu is drawn with (SSP_LOOK for SSP's own look)
    this._probes = new Map();     // probeImage by url and edge: each file is fetched once (SSP caches menu images by name)
    this._odm = odmState();       // the SHIORI's layer of the look (loadShioriLook); not asked yet
    this._odmQueue = Promise.resolve();   // SHIORI passes run one at a time
    this.odmReady = Promise.resolve();    // the requests of the last shell load's pass (setShell)
    this.thumb = thumbnail && typeof thumbnail.select === 'function' ? thumbnail : null;
    this._thumbRow = null;        // the selected row the thumbnail window last heard of (_syncThumb)
    this._pointer = null;         // the pointer while the menu is open, client px (where a thumbnail goes)
    this.infoWindow = null;
    // the language changed (here, in another tab, in the browser's settings): an open menu comes back in it
    this._offLang = this.language && typeof this.language.on === 'function'
      ? this.language.on('change', () => { if (this.el && this._at) this.open(this._at, this.prevFocus); })
      : null;
    this._loadLook();
  }

  /** the UI language of the runtime's own captions */
  get lang() { return this.language ? this.language.lang : 'en'; }

  get isOpen() { return !!this.el; }

  /** the deepest open submenu (null: none) */
  get subEl() { return this.subs.length ? this.subs[this.subs.length - 1] : null; }
  set subEl(el) { this.subs = el ? [el] : []; }

  /** The descripts' look (`_descriptLook`), with the SHIORI's answers so far (`look`), and the descripts' images. */
  _loadLook() {
    let descript = null;
    try { descript = this.stage && this.stage.shell && this.stage.shell.descript; } catch (e) { descript = null; }
    this._descript = descript || new Map();
    this._descriptLook = menuLook(this._descript, this.ghostDescript);
    this.look = menuLook(this._descript, this.ghostDescript, this._odm.keys);
    const L = this._descriptLook;
    const path = name => (name ? [this.shellDir + String(name).replace(/\\/g, '/')] : []);
    this._descriptPaths = { bg: path(L.background), fg: path(L.foreground), side: path(L.sidebar) };
    const e = edgeFlags(L);
    this.images = Promise.all(ODM_SLOTS.map(s => this._slotImage(this._descriptPaths[s], e[s])))
      .then(([bg, fg, side]) => ({ bg, fg, side }))
      .catch(() => ({ ...NO_IMAGES }));
  }

  /** probeImage of `url` with that edge, once per menu (null url: null) */
  _probe(url, bottomAligned) {
    if (!url) return Promise.resolve(null);
    const key = `${bottomAligned ? 1 : 0}|${url}`;
    let p = this._probes.get(key);
    if (!p) {
      p = probeImage(url, bottomAligned).catch(() => null);
      this._probes.set(key, p);
    }
    return p;
  }

  /** the first of `paths` (ghost-root paths) the files have whose image loads, probed with that edge; else null */
  async _slotImage(paths, bottomAligned) {
    const files = this.files;
    if (!files) return null;
    for (const p of paths || []) {
      if (!files.has(p)) continue;
      const img = await this._probe(files.url(p), bottomAligned);
      if (img) return img;
    }
    return null;
  }

  /**
   * The images the next popup is drawn with: a slot the SHIORI named its own (none when it did not load: SSP's reload
   * cleared that slot [disasm SetNum(0) 0x6972f6]), else the descripts', each probed for the edge its alignment flag
   * picks now (SetValues at every PreparePopup [disasm 0x697b70]).
   */
  _currentImages() {
    const st = this._odm;
    const e = edgeFlags(this.look || menuLook(null));
    return Promise.all(ODM_SLOTS.map(s => this._slotImage(st.paths[s] !== null ? st.paths[s] : this._descriptPaths[s], e[s])))
      .then(([bg, fg, side]) => ({ bg, fg, side }))
      .catch(() => ({ ...NO_IMAGES }));
  }

  /**
   * After a shell swap (UI §2.11): the new stage (dress-up, Move character window) and the new shell's menu.* look.
   * An open menu (or one still asking the ghost) is closed. SSP's shell change loads the shell again (LoadShell →
   * LoadGhostCore(0)), which asks the SHIORI for its look again [disasm 2.9.10 0x6231e3, 0x62161e]: `odmReady` is that
   * pass (loadShioriLook); the runtime waits for it before OnShellChanged.
   */
  setShell({ stage = this.stage, shellDir = this.shellDir } = {}) {
    this.token++;
    this.close({ restoreFocus: false });
    this.stage = stage;
    const dir = String(shellDir || 'shell/master/');
    this.shellDir = dir.endsWith('/') ? dir : dir + '/';
    this._odm = odmState();
    this._loadLook();
    this.odmReady = this.loadShioriLook();
  }

  /**
   * The SHIORI's menu look at a shell load (UI §2.3): SPGhost::LoadGhostCore calls GetODMFromShioriFromMainThread(1)
   * after the descripts' LoadSurface [disasm 2.9.10 0x62161e] at the ghost's load (EventLoop.boot awaits it after the
   * NOTIFY batch, before OnBoot: LoadShiori's NOTIFYs come first [disasm 0x6215c4, 0x621fe3]) and at every shell change
   * (setShell). The SHIORI layer starts again (InitMenuProp: sticky answers end here), one forced pass (odmPass) reloads
   * every slot it names, and whether later opens ask again is its result (SSP's gate = result 0 [disasm 0x6216f8]).
   * A colour's flag before the pass: the descripts' colour whose image did not load (LoadSurface's PreparePopup
   * cleared the rest [disasm 0x69711c]); only then are the descripts' images waited for. Resolves once the requests
   * are answered (the SHIORI's images load on their own); never rejects. Without a host that answers resources: nothing.
   * @returns {Promise<void>}
   */
  loadShioriLook() {
    if (!this.host || typeof this.host.resources !== 'function') return Promise.resolve();
    const st = odmState(this._descriptLook);
    this._odm = st;
    this.look = menuLook(this._descript, this.ghostDescript, st.keys);
    const colourSet = async which => {
      if (!this._descriptLook[`${which}Color`]) return false;
      const desc = (await this.images) || NO_IMAGES;
      return !desc[which === 'background' ? 'bg' : 'fg'];
    };
    return this._queueOdm(async () => {
      if (this._odm !== st) return;                 // a later shell load replaced it
      const r = await odmPass(ids => this.host.resources(ids, { timeoutMs: ODM_LOAD_MS }), st, { force: true, colourSet });
      if (this._odm !== st) return;
      st.loaded = true;
      st.complete = r.complete;
      this._afterOdm(st, r);
    });
  }

  /**
   * GetODMFromShiori(0) at a menu's open (ShowContextMenu [disasm 2.9.10 0x41b114]): nothing while the gate is set (the
   * load pass was incomplete, or none ran) [disasm 0x623778]; else a pass that reloads only a slot whose name changed
   * (no cache: every id is asked again [disasm GetStringShiori 0x712ba0]). Its result moves no gate.
   */
  _odmAtOpen() {
    return this._queueOdm(async () => {
      const st = this._odm;
      if (!st.loaded || !st.complete) return;
      const colourSet = async which => {
        if (!this.look[`${which}Color`]) return false;
        return !(await this._currentImages())[which === 'background' ? 'bg' : 'fg'];
      };
      const r = await odmPass(ids => this.host.resources(ids), st, { force: false, colourSet });
      if (this._odm !== st) return;
      this._afterOdm(st, r);
    });
  }

  /** a SHIORI pass after the ones queued before it; a failure is logged once and counts as no answer */
  _queueOdm(fn) {
    const p = this._odmQueue.then(fn).catch(e => log.once('menu-odm', 'menu: asking the SHIORI for its menu look failed', e));
    this._odmQueue = p;
    return p;
  }

  /** a pass's answers into the look; a reloaded slot is looked for where SSP looks (odmImagePaths), its probe started */
  _afterOdm(st, r) {
    for (const s of r.reload) st.paths[s] = odmImagePaths(st.names[s], this.shellDir);
    this.look = menuLook(this._descript, this.ghostDescript, st.keys);
    if (r.reload.size) this._currentImages();
  }

  /**
   * The images a popup is drawn with (open). Which look the menu has was decided at its shell's load
   * (SPGhost::LoadGhostCore [disasm 2.9.10 0x621623..0x6216f2]): the descripts' (LoadSurface took them, menuAccepted on
   * the descripts' images) or a complete SHIORI pass; else ssp_default_odm.txt over the keys, SSP's own look (SSP_LOOK).
   * A taken look carries `accepted` and LoadSurface's defaults of that load (`defaults`, menuColors' loadDefaults). A
   * menu whose shell load never asked the SHIORI (no loadShioriLook): LoadSurface's test on the descripts' images.
   */
  async _popupImages() {
    const st = this._odm;
    if (!st.loaded) {
      const loaded = (await this.images) || NO_IMAGES;
      return menuAccepted(this.look, loaded) ? loaded : SSP_LOOK;
    }
    const [desc, loaded] = await Promise.all([this.images, this._currentImages()]);
    const d = desc || NO_IMAGES;
    if (!menuAccepted(this._descriptLook, d) && !st.complete) return SSP_LOOK;
    const at = menuColors(this._descriptLook, d, { accepted: true });
    return { ...(loaded || NO_IMAGES), accepted: true, defaults: { disabled: at.disabled, separator: at.separator } };
  }

  /**
   * Resource IDs worth fetching at boot so the first menu has fallbacks for slow replies: the gate of a click on
   * `scope` (menuGateIds), then its own menu's (a Sumika addition: SSP asks nothing at boot).
   */
  prefetch(scope = 0) {
    if (this.host && typeof this.host.resources === 'function') {
      this.host.resources([...menuGateIds(scope), ...this._resourceIds(scope)], { timeoutMs: 5000 }).catch(() => {});
    }
  }

  /** whether `scope`'s character window exists, as ssp.exe's GetCharWnd finds one (0 always; Stage.has; else 1) */
  _hasScope(s) {
    const st = this.stage;
    return s === 0 || (st && typeof st.has === 'function' ? !!st.has(s) : s === 1);
  }

  /** the resource ids the menu of `scope` asks for (menuResourceIds with this menu's items) */
  _resourceIds(scope) {
    return menuResourceIds(scope, { devFunctions: this.devFunctions, preferences: !!this.preferences });
  }

  /** a provider's answer; a failing one is logged once and treated as absent */
  _ask(name, fn) {
    if (!fn) return null;
    try { return fn(); } catch (e) { log.once(`menu-${name}`, `menu: ${name} failed`, e); return null; }
  }

  /**
   * buildMenuModel's options for the menu of `scope` from the providers, the host and the stage. `bindScope` (default
   * `scope`): whose parts Clothes/Dressup ▸ lists (bindScopeOf); another's keep the root greyed or enabled by `scope`'s
   * own bind data [disasm 2.9.10 ModifyMenuWithTable 0x41c975..0x41ca01, UpdateBindMenu 0x41ede8].
   */
  _options(scope, bindScope = scope) {
    const lang = this.lang;
    const stage = this.stage;
    const host = this.host || {};
    const level = Number(host.enableLevel);
    let dressup = stage && typeof stage.dressupMenu === 'function' ? this._ask('dressup', () => stage.dressupMenu(scope)) : null;
    if (dressup && bindScope !== scope) {
      const parts = this._ask('dressup', () => stage.dressupMenu(bindScope)) || { mode: 'hidden', entries: [] };
      dressup = { ...parts, enabled: !!dressup.enabled };
    }
    const info = this.info ? infoFlags(this._ask('info', this.info)) : null;
    return {
      ghosts: this._ask('ghosts', this.ghosts),
      calls: this._ask('calls', this.calls),
      scaling: this.scaling ? this._ask('scaling', () => this.scaling.info()) : null,
      lang,
      languagePref: this.language ? this.language.pref : null,
      shells: this._ask('shells', this.shells),
      balloons: this._ask('balloons', this.balloons),
      dressup,
      dressupScope: bindScope,
      info,
      enableLevel: Number.isFinite(level) ? level : 0,
      devFunctions: this.devFunctions,
      carry: !!(stage && typeof stage.carry === 'function'),
      preferences: !!this.preferences,
      thumbs: this._thumbFinders(),
    };
  }

  /**
   * How a dress-up part's and a site row's thumbnails are found in the ghost's files (UI §2.14): the part's bind group
   * thumbnail in the current shell's folder, the banner in ghost/master/banner/ (else its web address), each with
   * SSP's any-extension lookup (thumbnail.js findLoadable, bannerUrls). Without the ghost's files: none. A local file's
   * URL is the one loadThumbnail fetches (versionedUrl: `?v=` when the manifest versions it).
   */
  _thumbFinders() {
    const files = this.files;
    if (!files || typeof files.list !== 'function' || typeof files.url !== 'function') return null;
    const url = p => (typeof files.versionedUrl === 'function' ? files.versionedUrl(p) : files.url(p));
    return {
      part: thumb => { const p = findLoadable(files, this.shellDir + String(thumb)); return p ? [url(p)] : []; },
      banner: banner => bannerUrls(files, banner),
    };
  }

  /**
   * Open the menu a click on `scope` opens at viewport point (x, y): the clicked character's `popupmenu.visible` and
   * `.type` first, then the shown menu's owner's captions (askMenu; UI §2.1 notes). `device` is the pointer that opened
   * it (EventLoop's req: 'touch' for a long press; MENU_TOUCH_ROW rows).
   * @param {{scope?: number, x?: number, y?: number, device?: string}} [at]
   * @param {Element|null} [focusBack] where the focus goes when it closes (default: what has it now)
   */
  async open({ scope = 0, x = 0, y = 0, device = 'mouse' } = {}, focusBack = null) {
    if (typeof document === 'undefined' || !this.host) return;
    const token = ++this.token;
    this.close({ restoreFocus: false });
    // the gate of the clicked character, then the shown menu's owner's batch (its applybindtoself first when it is
    // another's) [disasm 2.9.10 CCharWndCode::OnCWContextMenuSSP 0x41af93..0x41b0a5, CheckApplyBindToSelf 0x41cca0]
    const r = await askMenu(ids => this.host.resources(ids), scope, {
      has: s => this._hasScope(s), ids: s => this._resourceIds(s), live: () => token === this.token,
    });
    if (token !== this.token || !r) return;
    const opts = this._options(r.target, r.bindScope);
    const lang = opts.lang;
    const model = buildMenuModel(r.target, r.res, opts);
    if (!model || !model.length) return;
    // SSP asks the SHIORI for its look again after the captions, before the popup (CCharWndCode::ShowContextMenu:
    // ModifyPopupMenu, GetODMFromShiori(0), ShowPopup [disasm 2.9.10 0x41b10c, 0x41b114, 0x41b160]); no menu
    // (popupmenu.visible 0) is decided before it [disasm OnCWContextMenuSSP 0x41b082]
    await this._odmAtOpen();
    if (token !== this.token) return;
    // a look SSP would not take is replaced by its own, without the shell's images (_popupImages, menuColors)
    const images = await this._popupImages();
    if (token !== this.token) return;
    // the shown menu's character runs the picks; the clicked one is their R2 (Close, Quit) [disasm ShowContextMenu
    // 0x41b107: [target+0x78] = the clicked scope; PostMessage to the target 0x41b189]
    this.scope = r.target;
    this.clicked = scope;
    this._lastImages = images;
    this._touch = device === 'touch';
    this.prevFocus = focusBack || document.activeElement;
    this.el = this._render(model, images, false, lang);
    this._at = this._touch ? { scope, x, y, device } : { scope, x, y };
    this._pointer = { x, y };
    this._place(this.el, x, y);
    this._listen();
    // opened by the pointer, as SSP's is: no row is hot until the pointer or a key picks one (UI §2.3) [measured]; the
    // keys work from the start (_onKey)
    this._focusMenu(this.el);
  }

  close({ restoreFocus = true } = {}) {
    // Win32 tells the owner the menu closed (WM_MENUSELECT 0xFFFF): the thumbnail goes [disasm 0x41b78a]
    if (this._thumbRow && this.thumb) this.thumb.select(null);
    this._thumbRow = null;
    for (const tm of this._timers) clearTimeout(tm);
    this._timers = [];
    for (const s of this.subs) if (s && typeof s.remove === 'function') s.remove();
    this.subs = [];
    if (this.el) this.el.remove();
    const had = !!this.el;
    this.el = null;
    this._at = null;
    if (this._off) this._off();
    this._off = null;
    if (had && restoreFocus && this.prevFocus && typeof this.prevFocus.focus === 'function') {
      try { this.prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
    this.prevFocus = null;
  }

  destroy() {
    this.token++;
    this.close({ restoreFocus: false });
    this._odm = odmState();       // a pass still running keeps its answers to itself
    if (this._offLang) this._offLang();
    this._offLang = null;
    if (this.infoWindow) this.infoWindow.destroy();
    this.infoWindow = null;
  }

  // ---- DOM

  _render(model, images, isSub, lang = this.lang) {
    addStyle('menu', CSS);
    const L = this.look;
    images = images || NO_IMAGES;
    const el = document.createElement('div');
    el.className = 'smk-menu';
    if (this._touch) el.classList.add('smk-touch');   // opened by a touch: its submenus too (UI §9.11 F5)
    el.setAttribute('role', 'menu');
    el.setAttribute('lang', lang);              // the runtime's captions; the ghost's rows say lang="" (unknown)
    el.tabIndex = -1;
    el.__images = images;                       // what _applyMetrics / _layoutImages size and place
    const C = menuColors(L, images, { accepted: !!images.accepted, loadDefaults: images.defaults || null });
    for (const [k, v] of [['--smk-text', C.text], ['--smk-hot-text', C.hotText], ['--smk-disabled', C.disabled],
      ['--smk-sep', C.separator], ['--smk-bg', C.bg], ['--smk-hot-bg', C.hotBg], ['--smk-frame', C.frame]]) {
      el.style.setProperty(k, v);
    }
    if (images.bg) el.style.backgroundImage = `url("${images.bg.url}")`;
    if (images.side && !isSub) {               // the main menu's only (SSP: depth-1 items) [disasm]
      const side = document.createElement('div');
      side.className = 'smk-side';
      side.style.backgroundImage = `url("${images.side.url}")`;
      side.style.backgroundPosition = `left ${L.sidebarAlign}`;
      if (images.side.edge) side.style.backgroundColor = images.side.edge;
      el.appendChild(side);
    }
    this._applyMetrics(el);
    const rows = document.createElement('div');
    rows.className = 'smk-rows';
    el.appendChild(rows);
    for (const item of model) {
      if (item.kind === 'sep') {
        const s = document.createElement('div');
        s.className = 'smk-sep';
        s.setAttribute('role', 'separator');
        s.addEventListener('pointerenter', () => this._hoverSep(el, images));
        rows.appendChild(s);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'smk-row';
      // a submenu row stays a menuitem; its check (an auto dress-up category with a part worn) is only drawn
      const role = item.kind === 'sub' || item.checked === undefined ? 'menuitem' : item.toggle ? 'menuitemcheckbox' : 'menuitemradio';
      row.setAttribute('role', role);
      if (typeof item.lang === 'string') row.setAttribute('lang', item.lang);
      row.tabIndex = -1;
      if (item.checked !== undefined) {
        if (role !== 'menuitem') row.setAttribute('aria-checked', item.checked ? 'true' : 'false');
        if (item.checked) {
          // SSP's tick, or its dot (`radio` / `dot`: the items whose SSP ids are 6000–59999), as pixels (menuMetrics)
          const check = document.createElement('span');
          check.className = item.radio || item.dot ? 'smk-check smk-bullet' : 'smk-check';
          check.setAttribute('aria-hidden', 'true');
          row.appendChild(check);
        }
      }
      // a row in another language than the menu's (a ghost's name) keeps our note and its tooltip in the menu's
      const foreign = typeof item.lang === 'string' && item.lang !== lang;
      if (item.title || (item.note && !foreign)) row.title = item.title || item.note;
      const cap = parseCaption(item.label);
      const label = document.createElement('span');
      label.className = 'smk-label';
      for (const part of cap.parts) {
        if (part.key) { const u = document.createElement('u'); u.textContent = part.text; label.appendChild(u); }
        else label.appendChild(document.createTextNode(part.text));
      }
      row.appendChild(label);
      if (item.note) {                          // our note sits in the accelerator's column
        const note = document.createElement('span');
        note.className = 'smk-note';
        note.textContent = `(${item.note})`;
        if (foreign) { note.setAttribute('lang', lang); note.title = item.note; }
        row.appendChild(note);
      }
      if (cap.accel) {                          // a ghost caption's "\tCtrl+X": right-aligned, as SSP draws it
        const accel = document.createElement('span');
        accel.className = 'smk-accel';
        accel.textContent = cap.accel;
        row.appendChild(accel);
      }
      row.__item = item;
      row.__key = cap.key;
      row.__menu = el;
      const disabled = item.disabled || (item.kind === 'sub' && !item.items.length);
      if (disabled) row.setAttribute('aria-disabled', 'true');
      if (item.kind === 'sub') {
        row.setAttribute('aria-haspopup', 'menu');
        row.setAttribute('aria-expanded', 'false');
        const arrow = document.createElement('span');
        arrow.className = 'smk-arrow';            // SSP's filled triangle, as pixels (menuMetrics)
        arrow.setAttribute('aria-hidden', 'true');
        row.appendChild(arrow);
      }
      if (item.action && item.action.type === 'site' && item.action.url) row.title = item.action.url;
      row.addEventListener('pointerenter', () => this._hover(row, el, images));
      // a touch on the row that became a scroll (UI §9.11 F4); a mouse keeps its desktop path
      row.addEventListener('pointercancel', ev => { if (ev.pointerType !== 'mouse') this._cancelHover(el); });
      row.addEventListener('click', ev => { ev.stopPropagation(); this._activate(row, images); });
      rows.appendChild(row);
    }
    el.addEventListener('keydown', ev => this._onKey(ev, el, images));
    el.addEventListener('pointerleave', () => this._leave(el, images));
    el.addEventListener('contextmenu', ev => ev.preventDefault());
    getRoot().appendChild(el);
    this._layoutImages(el);
    return el;
  }

  /**
   * SSP's device-pixel metrics on a menu element (menuMetrics / menuVars at the current devicePixelRatio, with the
   * internal leading of the font it is drawn in and, opened by a touch, the touch spacing), and the font a descript
   * names (menuFontFamily). Again on a devicePixelRatio change (_refit).
   */
  _applyMetrics(el) {
    const L = this.look || menuLook(null);
    const dpr = currentDpr();
    const lang = el.getAttribute('lang');
    const named = menuFontFamily(L.fontName, lang);
    const th = menuTextHeight(dpr, L.fontHeight);
    const leading = menuInternalLeading(th, named || (lang === 'ja' ? MENU_FONTS_JA : MENU_FONTS));
    const m = menuMetrics(dpr, { fontHeight: L.fontHeight, leading, spacing: menuSpacing(dpr, th, this._touch) });
    for (const [k, v] of Object.entries(menuVars(m, el.__images || NO_IMAGES))) el.style.setProperty(k, v);
    el.style.fontFamily = named || '';
  }

  /**
   * Where an image of the menu sits, in device px from the top-left inside its frame, at one image pixel per device
   * pixel [disasm DrawItem 0x69627d]: SSP aligns it in the area right of the sidebar (A = the list's width, without a
   * scrollbar; the sidebar's width S in the main menu, 0 in a submenu): x = S (left), S + ⌊(A − w) / 2⌋ toward zero
   * (centre), S + A − w (right) [disasm; measured: emily4's 300-px background at −23 in 8.png, 24 + (206 − 300) / 2];
   * top / bottom of the whole list's height (SPMenuItem::GetMenuHeight; .smk-rows is as tall as its rows) [disasm].
   */
  _imageAt(menuEl, img, align) {
    const dpr = currentDpr();
    const [h, v] = String(align || 'left top').split(' ');
    const rect = sel => {
      const e = typeof menuEl.querySelector === 'function' ? menuEl.querySelector(sel) : null;
      return e && typeof e.getBoundingClientRect === 'function' ? e.getBoundingClientRect() : null;
    };
    const sb = rect('.smk-side');
    const lb = rect('.smk-rows');
    const S = Math.max(0, Math.round(((sb && sb.width) || 0) * dpr));
    const A = Math.max(0, Math.round(((lb && lb.width) || 0) * dpr));
    const H = Math.max(0, Math.round(((lb && lb.height) || 0) * dpr));
    const x = S + (h === 'right' ? A - img.width : h === 'center' ? Math.trunc((A - img.width) / 2) : 0);
    const y = v === 'bottom' ? H - img.height : 0;
    return { x, y };
  }

  /** The background image at its alignment (_imageAt), once the menu has its size. */
  _layoutImages(menuEl) {
    const bg = menuEl.__images && menuEl.__images.bg;
    if (!bg) return;
    const dpr = currentDpr();
    const { x, y } = this._imageAt(menuEl, bg, (this.look || {}).backgroundAlign);
    menuEl.style.backgroundPosition = `${devicePx(x, dpr)} ${devicePx(y, dpr)}`;
  }

  _rows(menuEl) { return [...menuEl.querySelectorAll('.smk-row')]; }

  _setHot(menuEl, row, images) {
    for (const r of this._rows(menuEl)) {
      if (r === row) continue;
      r.classList.remove('smk-hot');
      r.style.backgroundImage = '';
    }
    if (!row) { this._syncThumb(); return; }
    row.classList.add('smk-hot');
    this._syncThumb();
    if (images && images.fg) {
      // the hot row shows the foreground image's pixels at the same place (UI §2.3), a greyed row too (SSP draws
      // ODS_SELECTED whatever ODS_GRAYED says, only its text greyed) [disasm DrawItem]
      const dpr = currentDpr();
      const at = this._imageAt(menuEl, images.fg, (this.look || {}).foregroundAlign);
      const m = menuEl.getBoundingClientRect();
      const b = row.getBoundingClientRect();
      const dx = Math.round((b.left - m.left) * dpr) - 1;                         // device px inside the frame
      const dy = Math.round((b.top - m.top + (menuEl.scrollTop || 0)) * dpr) - 1;
      row.style.backgroundImage = `url("${images.fg.url}")`;
      row.style.backgroundPosition = `${devicePx(at.x - dx, dpr)} ${devicePx(at.y - dy, dpr)}`;
    }
  }

  /**
   * The row Windows calls selected, the one WM_MENUSELECT names: the hot row of the deepest menu that has one (a
   * pointer that left a submenu leaves its parent row selected) [win32: Wine MENU_SelectItem], or null.
   */
  _selectedRow() {
    for (let l = this.subs.length; l >= 0; l--) {
      const m = this._menuAt(l);
      const r = m && typeof m.querySelectorAll === 'function' ? this._hotRow(m) : null;
      if (r) return r;
    }
    return null;
  }

  /**
   * Tell the thumbnail window when the selected row changes (UI §2.14) [disasm CCharWndCode::OnCWMenuSelect]: an
   * enabled thumbnail row (thumbKey) with its thumbnails (a list, or a function that finds them), anything else as none
   * (a greyed row, a submenu's, another kind, nothing).
   */
  _syncThumb() {
    if (!this.thumb || !this.el) return;
    const row = this._selectedRow();
    if (row === this._thumbRow) return;
    this._thumbRow = row;
    const item = row && row.__item;
    const key = item && item.kind === 'item' && row.getAttribute('aria-disabled') !== 'true' ? thumbKey(item.action) : null;
    if (key) this.thumb.select(key, item.thumbs || [], () => this._pointer || { x: 0, y: 0 });
    else this.thumb.select(null);
  }

  /** Focus a menu without a hot row: the keys move from there (_onKey). */
  _focusMenu(menuEl) {
    this._setHot(menuEl, null, this._lastImages);
    menuEl.focus({ preventScroll: true });
  }

  _focusRow(menuEl, index) {
    const rows = this._rows(menuEl);
    if (!rows.length) { menuEl.focus({ preventScroll: true }); return; }
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    // a list taller than the viewport scrolls (max-height): keep the keyboard's row in sight (its offsetParent is
    // the fixed menu). Before _setHot, which reads scrollTop.
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const first = row === rows[0];
    const lastRow = row === rows[rows.length - 1];
    if (top < menuEl.scrollTop) menuEl.scrollTop = first ? 0 : top;              // the ends: to the very edge
    else if (bottom > menuEl.scrollTop + menuEl.clientHeight) menuEl.scrollTop = lastRow ? menuEl.scrollHeight : bottom - menuEl.clientHeight;
    this._setHot(menuEl, row, this._lastImages || { fg: null });
    row.focus({ preventScroll: true });
  }

  /** 0 for the main menu, n for the n-th open submenu, -1 for anything else */
  _level(menuEl) {
    if (menuEl && menuEl === this.el) return 0;
    const i = this.subs.indexOf(menuEl);
    return i < 0 ? -1 : i + 1;
  }

  _menuAt(level) { return level === 0 ? this.el : this.subs[level - 1] || null; }

  _hover(row, menuEl, images) {
    this._lastImages = images;
    const level = this._level(menuEl);
    if (level < 0) return;
    this._setHot(menuEl, row, images);
    // the pointer reached a submenu: rows of the menus above it that it crossed on the way neither open nor close one
    // (menu aim), and their parent rows stay highlighted
    for (let l = level; l > 0; l--) {
      clearTimeout(this._timers[l - 1]);
      const m = this._menuAt(l);
      if (m && m.__parentRow) this._setHot(this._menuAt(l - 1), m.__parentRow, images);
    }
    clearTimeout(this._timers[level]);
    const item = row.__item;
    const child = this._menuAt(level + 1);
    if (item && item.kind === 'sub' && row.getAttribute('aria-disabled') !== 'true') {
      if (child && child.__parentRow === row) return;                     // already open
      this._timers[level] = setTimeout(() => this._openSub(row, images, false), 150);
    } else if (child) {
      this._timers[level] = setTimeout(() => this._closeSubs(level), 250);
    }
  }

  /**
   * A touch on a row of `menuEl` turned into a scroll (pointercancel): the open or close its pointerenter asked of the
   * level below (_hover's timer) is dropped, so a scroll that starts on a "▸" row opens nothing (UI §9.11 F4).
   */
  _cancelHover(menuEl) {
    const level = this._level(menuEl);
    if (level >= 0) clearTimeout(this._timers[level]);
  }

  /** the row of `menuEl` whose submenu is open (null: none) */
  _openParent(menuEl) {
    const level = this._level(menuEl);
    const child = level < 0 ? null : this._menuAt(level + 1);
    return child && child.__parentRow && child.__parentRow.__menu === menuEl ? child.__parentRow : null;
  }

  _hotRow(menuEl) { return this._rows(menuEl).find(r => r.classList.contains('smk-hot')) || null; }

  /**
   * The pointer on a separator: no row is hot (Windows selects the separator, which SSP draws without a highlight:
   * it has no command id) [win32: Wine MENU_MouseMove; disasm DrawItem], and a submenu waiting to open does not. Coming
   * from the row of an open submenu, that row stays hot until the submenu closes, after the delay a plain row has; an
   * open submenu closes after it either way. The menus above keep their rows (menu aim, as _hover).
   */
  _hoverSep(menuEl, images) {
    this._lastImages = images;
    const level = this._level(menuEl);
    if (level < 0) return;
    for (let l = level; l > 0; l--) {
      clearTimeout(this._timers[l - 1]);
      const m = this._menuAt(l);
      if (m && m.__parentRow) this._setHot(this._menuAt(l - 1), m.__parentRow, images);
    }
    clearTimeout(this._timers[level]);
    const parent = this._openParent(menuEl);
    if (!parent || this._hotRow(menuEl) !== parent) this._setHot(menuEl, null, images);
    if (parent) this._timers[level] = setTimeout(() => { this._closeSubs(level); this._setHot(menuEl, null, images); }, 250);
  }

  /**
   * The pointer left a menu: its hot row goes, unless it is the row of the open submenu (Windows selects nothing in
   * the menu the pointer left; a submenu's parent item stays selected) [win32: Wine MENU_MouseMove].
   */
  _leave(menuEl, images) {
    if (this._level(menuEl) < 0) return;
    const hot = this._hotRow(menuEl);
    if (hot && hot !== this._openParent(menuEl)) this._setHot(menuEl, null, images);
  }

  /** Open the submenu of a `sub` row (closing whatever was open at that level or deeper). */
  _openSub(row, images, focus) {
    const item = row && row.__item;
    if (!item || item.kind !== 'sub' || !this.el) return;
    const level = this._level(row.__menu || this.el);
    if (level < 0) return;
    this._closeSubs(level);
    this._setHot(row.__menu || this.el, row, images);    // also when an access key opened it
    const sub = this._render(item.items, images, true, (this.el && this.el.getAttribute('lang')) || this.lang);
    sub.__parentRow = row;
    row.setAttribute('aria-expanded', 'true');
    this._placeSub(sub, row);
    this.subs.push(sub);
    if (focus) this._focusRow(sub, Math.max(0, this._rows(sub).findIndex(r => r.getAttribute('aria-disabled') !== 'true')));
  }

  /**
   * A submenu beside its row: its first row level with the row (the frame, 1 device px, above it) [win32: Windows
   * lines a submenu's first item up with its parent item], overlapping the parent by 2 px; flipped left of the parent
   * menu when the right side has no room.
   */
  _placeSub(sub, row) {
    const r = row.getBoundingClientRect();
    const parent = row.__menu || this.el;
    const p = parent && typeof parent.getBoundingClientRect === 'function' ? parent.getBoundingClientRect() : r;
    this._place(sub, r.right - 2, r.top - 1 / currentDpr(), p.left + 2);
  }

  /** Close the submenus below `level` (0: every submenu). */
  _closeSubs(level = 0) {
    while (this.subs.length > level) {
      const s = this.subs.pop();
      clearTimeout(this._timers[this.subs.length + 1]);
      const row = s.__parentRow;
      if (row) row.setAttribute('aria-expanded', 'false');
      if (typeof s.remove === 'function') s.remove();
    }
    this._syncThumb();
  }

  /** Close the deepest submenu. */
  _closeSub() {
    if (this.subs.length) this._closeSubs(this.subs.length - 1);
  }

  /**
   * Down-right of the point; flip when it would leave the viewport (UI §2.5). On whole device pixels, so the rows,
   * lines and pixel art (all whole device px) stay sharp.
   */
  _place(el, x, y, flipX = null) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const dpr = currentDpr();
    const snap = v => Math.round(v * dpr) / dpr;
    const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const w = (r && r.width) || el.offsetWidth || 0;
    const h = (r && r.height) || el.offsetHeight || 0;
    let left = x;
    let top = y;
    if (left + w > vw - 4) left = (flipX ?? x) - w;
    if (top + h > vh - 4) top = flipX === null ? y - h : vh - 4 - h;
    el.style.left = `${snap(Math.max(4, Math.min(left, vw - w - 4)))}px`;
    el.style.top = `${snap(Math.max(4, Math.min(top, vh - h - 4)))}px`;
  }

  /**
   * devicePixelRatio changed while the menu is open (another monitor: page zoom also resizes the window, which closes
   * it): every open level gets the new metrics and images in place and is placed again, as the characters and
   * balloons follow it (core/scaling.js bindWindow).
   */
  _refit() {
    if (!this.el) return;
    for (const m of [this.el, ...this.subs]) {
      this._applyMetrics(m);
      this._layoutImages(m);
    }
    if (this._at) this._place(this.el, this._at.x, this._at.y);
    for (const s of this.subs) if (s.__parentRow) this._placeSub(s, s.__parentRow);
    for (const m of [this.el, ...this.subs]) {
      const hot = this._rows(m).find(r => r.classList.contains('smk-hot'));
      if (hot) this._setHot(m, hot, m.__images);
    }
  }

  /** Watch devicePixelRatio as UserScaling.bindWindow does (a resolution media query); returns the unwatch. */
  _watchDpr() {
    const win = typeof window !== 'undefined' ? window : null;
    if (!win || typeof win.matchMedia !== 'function') return () => {};
    let mq = null;
    const onChange = () => { arm(); this._refit(); };
    const arm = () => {
      if (mq) mq.removeEventListener('change', onChange);
      mq = null;
      try {
        mq = win.matchMedia(`(resolution: ${currentDpr()}dppx)`);
        if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
        else mq = null;
      } catch (e) { mq = null; }
    };
    arm();
    return () => { if (mq) mq.removeEventListener('change', onChange); mq = null; };
  }

  _onKey(ev, menuEl, images) {
    this._lastImages = images;
    const rows = this._rows(menuEl);
    const cur = rows.indexOf(menuEl.querySelector('.smk-row.smk-hot'));
    const move = d => {
      if (!rows.length) return;
      // no hot row yet (just opened): Down takes the first row, Up the last [win32]
      let i = cur >= 0 ? cur : d > 0 ? -1 : rows.length;
      for (let n = 0; n < rows.length; n++) {
        i = (i + d + rows.length) % rows.length;
        if (rows[i].getAttribute('aria-disabled') !== 'true') break;
      }
      this._focusRow(menuEl, i);
    };
    const row = rows[cur];
    const enabled = r => r.getAttribute('aria-disabled') !== 'true';   // Home / End skip greyed rows, as the arrows do
    let handled = true;
    switch (ev.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'Home': { const i = rows.findIndex(enabled); this._focusRow(menuEl, i < 0 ? 0 : i); break; }
      case 'End': {   // a backward loop: Array.prototype.findLastIndex is Chrome 97 / Firefox 104 / Safari 15.4 (CLAUDE.md "Browsers")
        let i = rows.length - 1;
        while (i >= 0 && !enabled(rows[i])) i--;
        this._focusRow(menuEl, i < 0 ? rows.length - 1 : i);
        break;
      }
      case 'ArrowRight':                  // opens the row's submenu at any level
        if (row && row.__item.kind === 'sub' && enabled(row)) this._openSub(row, images, true);
        break;
      case 'ArrowLeft':
      case 'Escape': {
        const level = this._level(menuEl);
        if (level > 0) {                  // back one level: this submenu (and any below it) closes
          const parent = menuEl.__parentRow;
          this._closeSubs(level - 1);
          if (parent) { this._setHot(parent.__menu || this._menuAt(level - 1), parent, images); parent.focus({ preventScroll: true }); }
        } else if (ev.key === 'Escape') {
          this.close();
        }
        break;
      }
      case 'Enter':
      case ' ':
        if (row) this._activate(row, images, true);
        break;
      case 'Tab':
        this.close();
        break;
      default: {
        const k = ev.key && ev.key.length === 1 ? ev.key.toLowerCase() : null;
        const hit = k && rows.find(r => r.__key === k && r.getAttribute('aria-disabled') !== 'true');
        if (hit) this._activate(hit, images, true);
        else handled = false;
      }
    }
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }

  _activate(row, images, byKey = false) {
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    const item = row.__item;
    if (item.kind === 'sub') { this._openSub(row, images, byKey); return; }
    const action = item.action || {};
    const scope = this.scope;
    const clicked = this.clicked;
    this.close();
    this._run(action, scope, clicked);
  }

  /**
   * Run a picked item. Site URLs open here, inside the user's click (popup blockers; UI §2.4). `scope` is the menu's
   * character (the site list's R4, Move character window's), `clicked` the one whose click opened it (Close / Quit R2;
   * default the same) [disasm 2.9.10 CCWC_OnCommand 0x41d3de, 0x41d4ca, 0x41d503, 0x41d535].
   */
  _run(action, scope, clicked = scope) {
    const host = this.host;
    const call = (name, ...args) => {
      if (!host || typeof host[name] !== 'function') { log.once(`menu-host-${name}`, `menu: the event loop has no ${name}()`); return; }
      try { Promise.resolve(host[name](...args)).catch(e => log.error(`${name} failed`, e)); } catch (e) { log.error(`${name} failed`, e); }
    };
    switch (action.type) {
      case 'site': {
        const url = action.url || '';
        if (/^script:/i.test(url)) { if (host.playScript) host.playScript(url.slice(7), { event: 'OnRecommendsiteChoice' }); return; }
        if (/^https?:\/\//i.test(url)) {
          try { window.open(url, '_blank', 'noopener'); } catch (e) { /* blocked */ }
        } else {
          log.once(`site-url:${url}`, `menu: not opening "${url}"`);
        }
        host.send('OnRecommendsiteChoice', [action.title, url, action.banner || '', action.kind, scope, action.index]);
        break;
      }
      case 'reset':
        try { if (this.stage) this.stage.resetPositions(); } catch (e) { log.error('reset position failed', e); }
        try { if (host && host.balloons && host.balloons.resetOffsets) host.balloons.resetOffsets(); } // dragged balloons too
        catch (e) { log.error('reset balloon offsets failed', e); }
        break;
      case 'leavepassive':                // Utilities ▸ Reset passive mode (UI §2.11): leaves passive and induction mode
        call('setOption', 'leave', ['passivemode']);
        call('setOption', 'leave', ['inductionmode']);
        break;
      case 'scale':                       // Shell / Balloon scaling ▸ (UI §2.1 #8, #9); OnShellScaling / OnBalloonScaling
        if (this.scaling) this.scaling.set(action.target, action.percent);
        break;
      case 'scale-other':                 // Other percentage…: asked with the input box
        if (this.scaling) Promise.resolve(this.scaling.askOther(action.target, scope)).catch(e => log.error('scaling failed', e));
        break;
      case 'iconify':
        host.minimize('user');
        break;
      case 'ghost':                       // OnGhostChanging (R1 manual) to this ghost, then the switch (EV §2.5)
        if (host && typeof host.changeGhost === 'function') host.changeGhost(action.id, { reason: 'manual', raiseEvent: true, scope, byId: true });
        break;
      case 'callghost':                   // Call ghost ▸: OnGhostCalling (R1 manual) to this ghost, then the call (UI §2.1 #13)
        call('callGhost', action.id, { byId: true, raiseEvent: true, reason: 'manual', scope });
        break;
      case 'shell':                       // Shell ▸: OnShellChanging, then the swap (UI §2.11, EV §2.6)
        call('changeShell', action.id, { byId: true, raiseEvent: true, scope });
        break;
      case 'balloon':                     // Balloon ▸: re-skin, then OnBalloonChange (UI §2.11)
        call('changeBalloon', action.id, { byId: true, scope });
        break;
      case 'dressup':                     // Clothes/Dressup ▸: toggle the part at once (UI §2.11, EV §4.11)
        call('toggleDressup', action.scope ?? scope, action.id);
        break;
      case 'about':
      case 'readme':
      case 'terms':                       // Information ▸ (UI §2.11)
        this._showInfo(action.type);
        break;
      case 'carry':                       // Move character window: the character follows the pointer until a click
        try {
          const c = this.stage && typeof this.stage.carry === 'function' ? this.stage.carry(scope) : null;
          if (c && c.done) Promise.resolve(c.done).catch(e => log.error('move character failed', e));
        } catch (e) { log.error('move character failed', e); }
        break;
      case 'language':                    // Language ▸ (UI §2.10): stored site-wide; the loop sends OnLanguageChange
        if (this.language) this.language.set(action.pref);
        break;
      case 'preferences':                 // Options ▸ Preferences… (UI §2.13): the Site's Preferences box
        if (this.preferences) {
          try { this.preferences(); } catch (e) { log.error('preferences failed', e); }
        }
        break;
      case 'close':                       // this ghost: OnClose alone among several, else as Quit (UI §2.1 #21)
        // R1 the menu's character, R2 the clicked one [disasm 2.9.10 CCWC_OnCommand 0x41d503]
        if (clicked === scope) host.close(scope);
        else host.close(scope, { window: clicked });
        break;
      case 'quit':                        // every ghost (OnCloseAll → OnClose); a loop without quitAll: Close [disasm]
        if (host && typeof host.quitAll === 'function') {
          if (clicked === scope) call('quitAll', scope);
          else call('quitAll', scope, clicked);  // [disasm 0x41d4ca]
        } else if (clicked === scope) host.close(scope);
        else host.close(scope, { window: clicked });
        break;
      default:
        break;
    }
  }

  /** About Sumika / About this ghost / Terms of this ghost in the info window (ui/info.js). */
  _showInfo(kind) {
    const data = this._ask('info', this.info) || {};
    const content = kind === 'about' ? aboutContent(data) : kind === 'readme' ? readmeContent(data.sources) : termsContent(data.sources);
    if (!content) return;
    if (!this.infoWindow) this.infoWindow = new InfoWindow({ language: this.language });
    this.infoWindow.open(content);
  }

  _listen() {
    const inside = ev => {
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      return (this.el && path.includes(this.el)) || this.subs.some(s => path.includes(s));
    };
    const onDown = ev => { if (!inside(ev)) this.close({ restoreFocus: false }); };
    const onClose = () => this.close({ restoreFocus: false });
    const onScroll = ev => { if (!inside(ev)) onClose(); };
    // where the pointer is: a thumbnail goes to the side away from it (thumbnail.js placeThumbnail)
    const onMove = ev => { this._pointer = { x: ev.clientX, y: ev.clientY }; };
    const opts = { capture: true, passive: true };
    window.addEventListener('pointerdown', onDown, opts);
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, opts);
    const offDpr = this._watchDpr();
    this._off = () => {
      window.removeEventListener('pointerdown', onDown, opts);
      window.removeEventListener('pointermove', onMove, opts);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, opts);
      offDpr();
    };
  }
}
