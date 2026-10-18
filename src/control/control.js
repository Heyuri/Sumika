// The control page (sumika/index.html at the Sumika host, served as https://<host>/sumika/; docs/guide.md "Turning
// Sumika on or off"; [decision]: On, Off and Site default only, and no link to it from Sumika itself: the site links
// it from its own pages): where a visitor sets their own choice for this browser, Site default (no record), On or Off.
// It reads and writes core/choice.js's record in this origin's localStorage, which is the storage hub's data (the hub
// is a page of this host), so one choice covers every page that uses Sumika from this host: pages here directly, pages
// on other sites through data-hub. It loads nothing else (no ghost, engine, balloon or index) and writes only when the
// visitor picks a choice, at once. English or Japanese from the browser's languages; its text is this file's own table
// (the runtime's STRINGS stay out of this small bundle). Built by tools/build.mjs as engines/control.<h>.js, which the
// fixed-name sumika/index.html (controlHtml: the style, a noscript line, no inline script) names; main.js here mounts
// it. Accessible: one fieldset of radio buttons (each named by its title, described by its line), a status line.
import { CHOICE_KEY, readChoice, saveChoice } from '../core/choice.js';

/** The page's text, {host}: this host's name (location.host). Visitor words: no "hub", "origin" or "storage key". */
export const STRINGS = Object.freeze({
  en: Object.freeze({
    title: 'Sumika in this browser',
    intro: 'Sumika shows ukagaka ghosts, characters that talk and react to your clicks, on web pages. Choose here whether they appear for you.',
    legend: 'Show Sumika',
    'choice.site': 'Site default',
    'choice.site.hint': 'Each page shows Sumika as its site set it up: on, waiting as a button in a corner, or off.',
    'choice.on': 'On',
    'choice.on.hint': 'The ghosts appear on every page that has Sumika, also where the site would keep them off or behind a button. On a phone, some pages still show a button first.',
    'choice.off': 'Off',
    'choice.off.hint': 'No ghost and no button on any page. What the ghosts remember stays in this browser, so they carry on when you turn Sumika on again.',
    where: 'Your choice is kept in this browser only, for the pages that use Sumika from {host}. Pages you open or reload from now on follow it; a page already open stays as it is.',
    'status.saved': 'Saved: {choice}. Pages you open or reload from now on follow it.',
    'status.failed': 'Your choice could not be saved in this browser, so nothing changed.',
    'status.blocked': 'This browser does not let this page keep a choice, so each page follows its site\'s setting.',
    'status.newer': 'Your choice was saved by a newer version of this page. Reload this page to change it.',
  }),
  ja: Object.freeze({
    title: 'このブラウザでの Sumika',
    intro: 'Sumika は、話したりクリックに反応したりする伺かのゴーストをウェブページに表示します。あなたのブラウザで表示するかどうかを、ここで選べます。',
    legend: 'Sumika の表示',
    'choice.site': 'サイトの設定どおり',
    'choice.site.hint': '各ページで、サイトが決めたとおりに表示します（表示する、隅のボタンで待つ、表示しない）。',
    'choice.on': 'オン',
    'choice.on.hint': 'Sumika のあるすべてのページでゴーストを表示します。サイトが表示しない設定やボタンにしているページでも表示します。スマートフォンでは、最初にボタンを表示するページもあります。',
    'choice.off': 'オフ',
    'choice.off.hint': 'どのページにも、ゴーストもボタンも表示しません。ゴーストの記憶はこのブラウザに残るので、オンに戻すと続きから始まります。',
    where: 'この選択はこのブラウザにだけ保存され、{host} の Sumika を使うページが従います。これから開くページや再読み込みしたページから有効になり、今開いているページはそのままです。',
    'status.saved': '保存しました（{choice}）。これから開くページや再読み込みしたページから有効になります。',
    'status.failed': 'このブラウザに選択を保存できなかったため、何も変わっていません。',
    'status.blocked': 'このブラウザでは、このページが選択を保存できません。各ページはサイトの設定どおりになります。',
    'status.newer': 'この選択は、このページの新しい版で保存されています。変えるには、このページを再読み込みしてください。',
  }),
});

/** The radio buttons in their order: value = the stored choice ('site': no record). */
export const OPTIONS = Object.freeze(['site', 'on', 'off']);

/**
 * The page's language: the browser's languages (navigator.languages, else navigator.language) in their order, the
 * first that is Japanese or English (ja-JP: ja); none of them: English. core/i18n.js systemLanguage's rule, which the
 * runtime's "Use System Lang." follows (a test keeps the two equal), written here so its string table stays out of
 * this bundle.
 * @param {{languages?: string[], language?: string}|null} nav
 * @returns {'en'|'ja'}
 */
export function pageLanguage(nav) {
  let list = [];
  try {
    if (nav && Array.isArray(nav.languages) && nav.languages.length) list = nav.languages;
    else if (nav && nav.language) list = [nav.language];
  } catch (e) { list = []; }
  for (const tag of list) {
    const l = String(tag || '').split(/[-_]/)[0].trim().toLowerCase();
    if (l === 'ja' || l === 'en') return l;
  }
  return 'en';
}

/** A string of `lang` with {name} parameters filled in. */
export function text(key, lang, params = null) {
  const s = (STRINGS[lang] || STRINGS.en)[key] ?? STRINGS.en[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k]))) : s;
}

/** A radio button's value for a stored choice, and back. */
export const optionOf = choice => (choice === 'on' || choice === 'off' ? choice : 'site');
export const choiceOf = option => (option === 'on' || option === 'off' ? option : null);

/**
 * What the page shows for the stored record (readChoice's answer): the option selected, whether the buttons can be
 * used, and the status key to show at once (null: none). Blocked storage: Site default, disabled, 'status.blocked';
 * a newer page's record: its choice shown, disabled, 'status.newer'.
 * @param {{choice: 'on'|'off'|null, newer: boolean, blocked: boolean}} read
 * @returns {{option: 'site'|'on'|'off', disabled: boolean, status: string|null}}
 */
export function viewOf(read) {
  if (read.blocked) return { option: 'site', disabled: true, status: 'status.blocked' };
  if (read.newer) return { option: optionOf(read.choice), disabled: true, status: 'status.newer' };
  return { option: optionOf(read.choice), disabled: false, status: null };
}

/**
 * A pick, saved at once (core/choice.js saveChoice): {outcome, option, status} with the option to show afterwards
 * (the stored one again when the save did not happen) and the status line's text.
 * @param {Storage|null} storage
 * @param {'site'|'on'|'off'} option
 * @param {'en'|'ja'} lang
 */
export function pick(storage, option, lang) {
  const outcome = storage ? saveChoice(storage, choiceOf(option)) : 'failed';
  if (outcome === 'saved') {
    return { outcome, option, status: text('status.saved', lang, { choice: text(`choice.${option}`, lang) }) };
  }
  const now = readChoice(storage);
  return { outcome, option: optionOf(now.choice), status: text(outcome === 'newer' ? 'status.newer' : 'status.failed', lang) };
}

/**
 * Builds the page into doc.body (the HTML holds the style and a noscript line only): the title and lang, a heading,
 * the intro, the fieldset of three radio buttons (the stored choice checked), a status line (role status) and where
 * the choice applies. A pick saves at once and says so; another tab's save (a `storage` event of the key) moves the
 * selection and takes this page's status line back (viewOf's). Uses createElement, appendChild, setAttribute, textContent, addEventListener and the inputs' properties.
 * @param {Document} doc
 * @param {{storage: Storage|null, nav: object, host: string, win?: object}} o storage: this origin's localStorage
 *   (null when the browser refuses it); nav: the navigator, whose languages pick English or Japanese (pageLanguage);
 *   host: this host's name (location.host); win: where `storage` events arrive
 * @returns {{lang: string, inputs: object, status: object}}
 */
export function mount(doc, { storage, nav, host, win = null }) {
  const lang = pageLanguage(nav);
  const el = (tag, props = {}, kids = []) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') e.textContent = v;
      else if (k === 'attrs') for (const [a, x] of Object.entries(v)) e.setAttribute(a, x);
      else e[k] = v;
    }
    for (const c of kids) e.appendChild(c);
    return e;
  };
  if (doc.documentElement) doc.documentElement.setAttribute('lang', lang);
  doc.title = text('title', lang);
  const view = viewOf(readChoice(storage));
  const status = el('p', { className: 'status', attrs: { role: 'status', 'aria-live': 'polite' }, text: view.status ? text(view.status, lang) : '' });
  const inputs = {};
  const rows = OPTIONS.map(o => {
    const id = `sumika-choice-${o}`;
    const input = el('input', { type: 'radio', name: 'sumika-choice', value: o, id, checked: o === view.option, disabled: view.disabled,
      attrs: { 'aria-labelledby': `${id}-name`, 'aria-describedby': `${id}-hint` } });
    inputs[o] = input;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      const r = pick(storage, o, lang);
      for (const k of OPTIONS) inputs[k].checked = k === r.option;
      status.textContent = r.status;
    });
    return el('label', { className: 'option', attrs: { for: id } }, [
      input,
      el('span', { className: 'name', id: `${id}-name`, text: text(`choice.${o}`, lang) }),
      el('span', { className: 'hint', id: `${id}-hint`, text: text(`choice.${o}.hint`, lang) }),
    ]);
  });
  const main = el('main', {}, [
    el('h1', { text: text('title', lang) }),
    el('p', { text: text('intro', lang) }),
    el('fieldset', {}, [el('legend', { text: text('legend', lang) }), ...rows]),
    status,
    el('p', { className: 'where', text: text('where', lang, { host }) }),
  ]);
  doc.body.appendChild(main);
  // another tab's pick (the control page open twice): the selection follows, nothing is written; this page's own
  // "Saved" line went stale with it, so the line becomes the stored record's (a newer page's: disabled, as on load)
  // or none [review: a real browser showed On checked under "Saved: Off"]
  if (win && typeof win.addEventListener === 'function' && !view.disabled) {
    win.addEventListener('storage', ev => {
      if (!ev || (ev.key !== CHOICE_KEY && ev.key !== null)) return;
      const now = viewOf(readChoice(storage));
      for (const k of OPTIONS) { inputs[k].checked = k === now.option; inputs[k].disabled = now.disabled; }
      status.textContent = now.status ? text(now.status, lang) : '';
    });
  }
  return { lang, inputs, status };
}
