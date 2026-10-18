// The visitor's user information (UI §2.13; EV §4.16): SSP's four user fields, Name, Nickname, Birthday and Sex
// (app.dat UserName, UserCallName, UserBirthday, UserSex [disasm 0x72a051, 0x4a5160–0x4a5417]), one set for the whole
// site, as SSP keeps one set for the whole install. Kept in the visitor's browser only, in the runtime prefs
// (localStorage `sumika:runtime`, key `user` = {name?, nickname?, birthday?: 'YYYY-MM-DD' | '', sex?: 'male' |
// 'female' | 'undef'}; a key that is absent was never set). Never logged, never put in a URL, and sent nowhere but to
// the ghosts' own engines (OnNotifyUserInfo, %username) [decision]. Emits 'change' {data, prev} when the data changed:
// an edit in this tab (the Preferences box) or in another (storage event).
import { Emitter } from './emitter.js';
import { runtimePrefs, RUNTIME_KEY, memoryStorage } from './state.js';
import { storageSource } from './platform.js';

/** the runtime prefs key */
export const USER_KEY = 'user';
/** SSP's UserSex values: the General page's Male / Female / Undefined radios [disasm OnSexChoice 0x4a53c0] */
export const SEXES = Object.freeze(['male', 'female', 'undef']);
const TEXT_FIELDS = ['name', 'nickname'];
// <input type="date">'s value: a year of four digits or more, a month and a day
const DATE = /^(\d{4,})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Stored user data cleaned: name and nickname any string (never trimmed, as SSP's edits); birthday 'YYYY-MM-DD' or ''
 * (another string: '', no birthday); sex one of SEXES. Anything else is left out (= never set).
 */
export function normUser(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const k of TEXT_FIELDS) if (typeof v[k] === 'string') out[k] = v[k];
  if (typeof v.birthday === 'string') out.birthday = DATE.test(v.birthday) ? v.birthday : '';
  if (SEXES.includes(v.sex)) out.sex = v.sex;
  return out;
}

/**
 * OnNotifyUserInfo's R2 for a stored birthday: 'YYYY,MM,DD', zero-padded as ssp.exe's "%04d,%02d,%02d" (UKADOC writes
 * 2003,5,5) [disasm SPShiori::NotifyUserInfo 0x70f440]; '' without one.
 */
export function birthdayRef(s) {
  const m = DATE.exec(String(s ?? ''));
  return m ? `${m[1]},${m[2]},${m[3]}` : '';
}

const same = (a, b) => JSON.stringify(normUser(a)) === JSON.stringify(normUser(b));
const USER_FIELDS = [...TEXT_FIELDS, 'birthday', 'sex'];

/** The stored `user` keys other than the four fields (a newer runtime's), as they are. */
function unknownUserKeys(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (!USER_FIELDS.includes(k)) out[k] = x;
  return out;
}
const filled = v => (typeof v === 'string' && v !== '' ? v : null);

export class UserProfile extends Emitter {
  /**
   * @param {{storage?: Storage|null}} [o] where the runtime prefs live (default localStorage, else memory); null: this
   *   page only
   */
  constructor({ storage } = {}) {
    super();
    this.storage = storage === null ? memoryStorage() : storage;
    this._data = this._stored();
    this._seen = JSON.stringify(this._data);     // the stored value last read or written
    this._off = null;
  }

  _stored() { return normUser(runtimePrefs.get(this.storage)[USER_KEY]); }

  /** a copy: {name?, nickname?, birthday?, sex?} */
  get data() { return { ...this._data }; }

  /** the visitor has saved the box once: any of the four fields is stored (an empty one too) */
  isSet() { return Object.keys(this._data).length > 0; }

  /**
   * OnNotifyUserInfo's References [disasm 0x70f440]: R0 the nickname, else the name (an empty field counts as not
   * given), else ''; R1 the name or ''; R2 the birthday 'YYYY,MM,DD' or ''; R3 the sex or 'undef' (SSP's default).
   */
  refs() {
    const d = this._data;
    return [filled(d.nickname) ?? filled(d.name) ?? '', d.name ?? '', birthdayRef(d.birthday), d.sex ?? 'undef'];
  }

  /** %username's fallback after the ghost's own `username` (EV §4.16): the nickname, else the name, else null */
  nickname() {
    return filled(this._data.nickname) ?? filled(this._data.name);
  }

  /**
   * Store a patch at once (SSP writes each keystroke [disasm OnChangeCallname 0x4a5240]): name / nickname as strings,
   * birthday 'YYYY-MM-DD' or '' (no birthday), sex one of SEXES (another value is ignored); undefined / null keys are
   * left as they are. True (and 'change') when the data changed.
   */
  set(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const next = { ...this._data };
    for (const k of [...TEXT_FIELDS, 'birthday']) {
      if (patch[k] !== undefined && patch[k] !== null) next[k] = String(patch[k]);
    }
    if (SEXES.includes(patch.sex)) next.sex = patch.sex;
    const data = normUser(next);
    if (same(data, this._data)) return false;
    // a newer runtime's own `user` sub-keys stay as stored (schema.js: every writer keeps the fields it does not know)
    runtimePrefs.set({ [USER_KEY]: { ...unknownUserKeys(runtimePrefs.get(this.storage)[USER_KEY]), ...data } }, this.storage);
    this._seen = JSON.stringify(this._stored());   // unchanged when the write failed: a refresh then keeps ours
    return this._update(data);
  }

  /** Read the stored data again (another tab saved its box); true (and 'change') when it differs. */
  refresh() {
    const stored = this._stored();
    const seen = JSON.stringify(stored);
    if (seen === this._seen) return false;          // the runtime prefs changed elsewhere (the set, the language)
    this._seen = seen;
    return this._update(stored);
  }

  _update(data) {
    if (same(data, this._data)) return false;
    const prev = this._data;
    this._data = data;
    this.emit('change', { data: { ...data }, prev: { ...prev } });
    return true;
  }

  /** Follow another tab's edits (storage event: the window's, or the storage hub's, core/platform.js storageSource). */
  bindWindow(win = typeof window !== 'undefined' ? window : null) {
    if (this._off || !win || typeof win.addEventListener !== 'function') return;
    const onStorage = ev => { if (!ev || ev.key === RUNTIME_KEY || ev.key === null) this.refresh(); };
    const src = storageSource(win);
    src.addEventListener('storage', onStorage);
    this._off = () => src.removeEventListener('storage', onStorage);
  }

  dispose() {
    if (this._off) this._off();
    this._off = null;
  }
}

let shared = null;

/** The page's one UserProfile (the Site's). */
export function sharedUser() {
  return shared || (shared = new UserProfile());
}
