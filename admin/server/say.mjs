// The program's own text (CONTRACTS "Admin API"): the console lines (each printed in English, then Japanese), the
// preview's test page and the file dialogs' titles and file kinds (picker.mjs), from the admin page's table
// (admin/page/strings.js: its t() fills the fixed names such as {app}) when it has the key, else from the program's
// own table below, so the program speaks both languages whatever the page's table holds. Names, paths and addresses are parameters, never words of a string (the strings test's rule).

export const APP = 'sumika-admin';

/** Every key the program looks up, for the admin page's strings test (which reads this export: keep it stable). */
export const STRING_KEYS = Object.freeze([
  'console.version', 'console.open', 'console.stop', 'console.already', 'console.failed', 'console.enter',
  'console.stopped', 'console.idle',
  'preview.page.title', 'preview.page.intro', 'preview.page.link',
  'pick.title.files', 'pick.title.folders', 'pick.title.site', 'pick.title.compare', 'pick.filter.archives',
  'pick.filter.compare',
]);

const OWN = {
  en: {
    'console.version': '{app} version {version}',
    'console.open': 'Open this address in your browser: {url}',
    'console.stop': 'Close this window to stop {app}.',
    'console.already': '{app} is already running: opening it in your browser.',
    'console.failed': '{app} could not start: {error}',
    'console.enter': 'Press the Enter key to close this window.',
    'console.stopped': '{app} has stopped.',
    'console.idle': '{app} stopped after {minutes} minutes without use.',
    'preview.page.title': 'Sumika preview: {origin}',
    'preview.page.intro': 'This test page is on {origin}. It loads Sumika from {site} with the storage hub.',
    'preview.page.link': 'Go to the same page on {other}: the ghost should go on where she was.',
    'pick.title.files': 'Choose {exts} files to add',
    'pick.title.folders': 'Choose ghost folders, or folders of ghosts, to add',
    'pick.title.site': 'Choose the site folder (the one that holds the {sumikaDir} folder)',
    'pick.title.compare': 'Choose the archive or update list to compare with',
    'pick.filter.archives': 'Ghost archives ({patterns})',
    'pick.filter.compare': 'Archives and update lists ({patterns})',
  },
  ja: {
    'console.version': '{app} バージョン {version}',
    'console.open': 'ブラウザでこのアドレスを開いてください：{url}',
    'console.stop': 'このウィンドウを閉じると {app} は終了します。',
    'console.already': '{app} は既に起動しています。ブラウザで開きます。',
    'console.failed': '{app} を起動できませんでした：{error}',
    'console.enter': 'エンターキーを押すと、このウィンドウを閉じます。',
    'console.stopped': '{app} は終了しました。',
    'console.idle': '{app} は{minutes}分間使われなかったので終了しました。',
    'preview.page.title': 'Sumikaのプレビュー：{origin}',
    'preview.page.intro': 'このテスト用ページは {origin} にあります。Sumikaを {site} からストレージハブ付きで読み込んでいます。',
    'preview.page.link': '{other} の同じページへ移動：ゴーストは続きから再開するはずです。',
    'pick.title.files': '追加する {exts} ファイルを選ぶ',
    'pick.title.folders': '追加するゴーストのフォルダ（またはゴーストの入ったフォルダ）を選ぶ',
    'pick.title.site': 'サイトのフォルダ（{sumikaDir} フォルダが入っているもの）を選ぶ',
    'pick.title.compare': '比較するアーカイブか更新リストを選ぶ',
    'pick.filter.archives': 'ゴーストのアーカイブ（{patterns}）',
    'pick.filter.compare': 'アーカイブと更新リスト（{patterns}）',
  },
};

let table = null;

/** Loads the admin page's table once (none, or one that fails to load: the program's own table only). */
export async function loadStrings() {
  if (table !== null) return;
  try {
    const m = await import('../page/strings.js');
    table = m && typeof m.t === 'function' && typeof m.has === 'function' ? m : false;
  } catch (e) {
    table = false;
  }
}

const fill = (s, params) => s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));

/** The text of a key in a language ('ja' | 'en'): the page's table, else the program's own. */
export function say(key, lang = 'en', params = null) {
  const l = lang === 'ja' ? 'ja' : 'en';
  const p = { app: APP, ...(params || {}) };
  if (table && table.has(key)) return table.t(key, l, p);
  return fill(OWN[l][key] ?? OWN.en[key] ?? key, p);
}

/** A console line in both languages (English first). */
export const sayBoth = (key, params = null) => [say(key, 'en', params), say(key, 'ja', params)];
