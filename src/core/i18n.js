// The runtime's own UI text in SSP's two languages (ssp-ui.md §2.10). Pure: no DOM, no storage (core/language.js
// keeps the visitor's choice). Text a ghost provides (SHIORI caption resources, site lists, descript names, input box
// titles) is never looked up here: it shows as the ghost wrote it in both languages.
// Captions keep Windows access keys: '&X' (ui/menu.js parseCaption). SSP's Japanese captions end in '(&X)' (one, Call
// ghost ▸, in '（&Z)'), so they read 'ゴースト切り替え(G)' with the G underlined; the English ones underline a letter of
// the word.

/** SSP's language packs (data/language/<dir>/descript.txt `name`, `id`); the Language ▸ menu lists them in this order */
export const LANGUAGES = Object.freeze({
  ja: Object.freeze({ name: 'Japanese', id: 1041 }),
  en: Object.freeze({ name: 'English', id: 1033 }),
});
export const UI_LANGS = Object.freeze(Object.keys(LANGUAGES));
/** the stored choice: a language, or 'system' (SSP's "Use System Lang."; also what nothing stored means) */
export const LANG_PREFS = Object.freeze([...UI_LANGS, 'system']);

// SSP: the string is ssp.exe 2.9.08f's own (ja: ssp.exe MENU 102 / 128 lang 1041, `docs/research/scratch/menu_ja.txt`;
// en: data/language/english/resource.dll MENU 102 / 128, `scratch/menu_en.txt`; the info.* window's from DIALOG 109 /
// 175, the settings.* box's from DIALOG 124 / 105, `scratch/sspui/dialogs_{ja,en}.txt`; menu.charMove from
// data/language/*/message.txt). ours: the runtime's, worded in SSP's style.
export const STRINGS = Object.freeze({
  en: Object.freeze({
    'menu.recommend': '&Recommendations',                      // SSP
    'menu.portal': 'Por&tal site',                             // SSP
    'menu.shellScale': 'Sh&ell scaling',                       // SSP
    'menu.balloonScale': 'Balloon scaling (&D)',               // SSP
    'menu.scale.default': '&Default (match display)',          // ours (stands in for "Additional settings (Same as ghost preferences)")
    'menu.scale.defaultPhone': '&Default (fit to screen)',     // ours: the same on phones, whose default is the fit (UI §9.11)
    'menu.scale.other': '&Other percentage...',                // SSP
    'menu.scale.display': 'display',                           // ours: note on the display's own percentage
    'menu.scale.displayTitle': '{p}% matches your display (its scaling times the browser zoom)',   // ours
    'menu.utilities': 'Utilities (&F)',                        // SSP
    'menu.resetPosition': 'Reset s&hell position',             // SSP
    'menu.changeGhost': 'Change &ghost',                       // SSP
    'menu.callGhost': 'Call ghost (&Z)',                       // SSP (MENU 102 position 15)
    'menu.callLimit': 'up to {n} at once',                     // ours: Call ghost ▸ while the site's cap is reached (UI §2.1 #13)
    'menu.needs': 'needs {engine}',                            // ours: a ghost whose engine the runtime lacks
    'menu.language': '&Language',                              // SSP (the same in every language)
    // SSP: hard-coded in ssp.exe (.rdata 0x739C38) and inserted at run time in every language (id 5056), after
    // Language ▸'s resource items are removed; resource.dll's '&Use system lang.' never shows (UI §2.10)
    'menu.language.system': '&Use System Lang.',
    'menu.iconify': '&Iconify',                                // SSP
    'menu.close': 'Close (&W)',                                // SSP (MENU 102, the main menu)
    'menu.closeSub': 'Close',                                  // SSP (MENU 128, the abbreviated menu: no access key)
    'menu.shell': '&Shell',                                    // SSP
    'menu.dressup': '&Clothes/Dressup',                        // SSP (MENU 102 and 128)
    'menu.dressupExplorer': 'Dressup &explorer',               // SSP 5086
    'menu.balloon': '&Balloon',                                // SSP
    'menu.info': 'Inform&ation',                               // SSP
    'menu.about': '&About Sumika...',                          // ours, in SSP 5080's slot ("&About SSP...")
    'menu.readme': 'About this &ghost...',                     // SSP 5051
    'menu.terms': '&Terms of this ghost...',                   // SSP 5098
    'menu.help': '&Help',                                      // SSP 5053
    'menu.aiGraph': 'A&I graph',                               // SSP 5082
    'menu.usage': 'Ghost usage statistics (&R)',               // SSP 5052
    'menu.sysinfo': 'Output &system information',              // SSP 5075
    'menu.leavePassive': 'Reset &passive mode',                // SSP 5057 (Utilities ▸, developer functions only)
    'menu.options': '&Options',                                // SSP (MENU 102)
    'menu.preferences': '&Preferences...',                     // SSP 5071 (Options ▸)
    // SSP: message.txt resource.setting.balloon.command item 6; ssp.exe inserts it at run time (id 5106), no access key
    'menu.charMove': 'Move character window',
    'menu.quit': 'Quit (&X)',                                  // SSP 5049 (both menus)
    // the Preferences box (UI §2.13): SSP's DIALOG 124 and the General page's "User information" group (DIALOG 105)
    'settings.title': 'Preferences',                           // ours: DIALOG 124's title without "SSP: "
    'settings.general': 'General',                             // ours: DIALOG 105's title up to its colon
    'settings.user': 'User information',                       // SSP
    'settings.name': 'Name:',                                  // SSP
    'settings.nickname': 'Nickname:',                          // SSP
    'settings.birthday': 'Birthday:',                          // SSP
    'settings.sex': 'Sex:',                                    // SSP
    'settings.sex.male': 'Male',                               // SSP
    'settings.sex.female': 'Female',                           // SSP
    'settings.sex.undef': 'Undefined',                         // SSP
    'settings.note': 'Unless otherwise noted, changes will take effect immediately',   // SSP (DIALOG 124)
    'settings.close': 'Close',                                 // ours: DIALOG 124's "&Close" without the access key
    'info.readme': 'About this character',                     // SSP DIALOG 109's title
    'info.author': 'Author:',                                  // SSP DIALOG 109
    'info.url': 'URL:',                                        // SSP DIALOG 109
    'info.none': '(N/A)',                                      // SSP DIALOG 109
    'info.ok': 'OK',                                           // SSP
    'info.terms': 'Terms of use: {file}',                      // SSP DIALOG 175's title [guess: for the menu's viewer]
    'info.about': 'About Sumika',                              // ours
    'info.aboutText': 'Sumika runs ukagaka ghosts in a browser tab, from their original files.',   // ours
    'info.version': 'Version {v}',                             // ours
    'info.developer': 'Developed by {name}',                   // ours
    'info.engine': 'SHIORI: {name}',                           // ours
    'info.midi': 'MIDI: {name}',                               // ours: the MIDI player
    'info.bank': 'Sound bank: {name}',                         // ours: its sound bank
    'info.source.ghost': 'Ghost',                              // ours: the readme window's switcher
    'info.source.shell': 'Shell',                              // ours
    'info.source.balloon': 'Balloon',                          // ours
    'info.close': 'Close',                                     // ours: the window's ×
    'launcher.call': 'Call {name}',                            // ours: the closed ghost's button
    'launcher.show': 'Show {name}',                            // ours: the minimized ghost's button
    'launcher.someone': 'the ghost',                           // ours: a ghost without a name
    'box.input': 'Input',                                      // ours: an input box without a title
    'box.communicate': 'Communicate',                          // ours: the communicate box
    'box.say': 'Say something',                                // ours: its field
    'box.teach': 'Teach',                                      // ours: the teach box and its field (balloonc2's "Teach")
    'box.send': 'Send',                                        // ours: its OK button
    'box.close': 'Close',                                      // ours: × buttons
    // Other percentage…'s box: SSP's dialog (DIALOG 140) is titled シェル倍率 and only exists in Japanese (resource.dll
    // has none); in English its name is MENU 102's caption without the access key
    'scale.box.shell': 'Shell scaling',                        // SSP
    'scale.box.balloon': 'Balloon scaling',                    // SSP
    'scale.hint': '{name}: {min}–{max} %',                     // ours: its tooltip (after DIALOG 140's "シェル倍率 : ")
    'scale.range': '{min}–{max} %',                            // ours: its placeholder
  }),
  ja: Object.freeze({
    'menu.recommend': 'おすすめ(&R)',
    'menu.portal': 'ポータルサイト(&T)',
    'menu.shellScale': 'シェル倍率(&E)',
    'menu.balloonScale': 'バルーン倍率(&D)',
    // ours ("標準": SSP's word for default, dialog 145); the space before "(&D)" after a parenthesis is SSP's, as in
    // the item this stands in for, "詳細設定(ゴーストごとの設定) (&D)..."
    'menu.scale.default': '標準(画面に合わせる) (&D)',
    'menu.scale.defaultPhone': '標準(画面に合わせる) (&D)',          // the Japanese already says "fit to screen"
    'menu.scale.other': 'その他の倍率(&O)...',
    'menu.scale.display': '画面',                               // ours ("画面": SSP's word for the display, dialog 103)
    'menu.scale.displayTitle': '{p}% がこの画面に合った倍率です (画面の拡大率×ブラウザのズーム)',
    'menu.utilities': '機能(&F)',
    'menu.resetPosition': 'シェル位置初期化(&H)',
    'menu.changeGhost': 'ゴースト切り替え(&G)',
    // SSP's own string has a full-width '（' and a half-width ')' (ssp.exe MENU 102 lang 1041; History ▸'s copy of it
    // is half-width: '他のゴーストを呼ぶ(&Z)')
    'menu.callGhost': '他のゴーストを呼ぶ（&Z)',
    'menu.callLimit': '同時に{n}体まで',
    'menu.needs': '{engine}が必要',
    'menu.language': '&Language',
    'menu.language.system': '&Use System Lang.',
    'menu.iconify': 'アイコン化(&I)',
    'menu.close': '終了(&W)',
    'menu.closeSub': '終了',
    'menu.shell': 'シェル(&S)',
    'menu.dressup': '着せ替え(&C)',
    'menu.dressupExplorer': '着せ替えエクスプローラ(&E)',
    'menu.balloon': 'バルーン(&B)',
    'menu.info': '情報(&A)',
    'menu.about': 'Sumikaについて(&A)',                         // ours (SSP: SSPについて(&A))
    'menu.readme': 'キャラクタについて(&G)',
    'menu.terms': 'キャラクタの利用条件(&T)',
    'menu.help': '説明書(&H)',
    'menu.aiGraph': 'AIグラフ(&I)',
    'menu.usage': '使用頻度表示(&R)',
    'menu.sysinfo': 'システム情報を書出(&S)',
    'menu.leavePassive': '制限モード強制解除(&P)',
    'menu.options': '設定(&O)',
    'menu.preferences': '本体設定...(&P)',
    'menu.charMove': 'ゴースト本体移動',
    'menu.quit': '全て終了(&X)',
    'settings.title': '設定',                                   // ours: DIALOG 124's "SSP:設定" without "SSP:"
    'settings.general': '一般',                                 // ours: DIALOG 105's "一般 : SSP全体の設定" up to its colon
    'settings.user': 'ユーザ情報',
    'settings.name': '名前 :',
    'settings.nickname': '呼ばれ方 :',
    'settings.birthday': '誕生日 :',
    'settings.sex': '性別 :',
    'settings.sex.male': '男',
    'settings.sex.female': '女',
    'settings.sex.undef': '未設定',
    'settings.note': '一部の設定を除き、変更はすぐに反映されます。',
    'settings.close': '閉じる',                                  // ours: DIALOG 124's "閉じる(&C)" without the access key
    'info.readme': 'キャラクタについて',
    'info.author': '作者名：',
    'info.url': 'URL：',
    'info.none': '(N/A)',
    'info.ok': 'OK',
    'info.terms': '利用条件 : {file}',
    'info.about': 'Sumikaについて',
    'info.aboutText': 'Sumikaは、伺かのゴーストを元のファイルのままブラウザのタブで動かします。',
    'info.version': 'バージョン {v}',
    'info.developer': '開発：{name}',
    'info.engine': 'SHIORI：{name}',                           // ours, with DIALOG 109's full-width colon ("作者名：")
    'info.midi': 'MIDI：{name}',
    'info.bank': '音色データ：{name}',
    'info.source.ghost': 'ゴースト',
    'info.source.shell': 'シェル',
    'info.source.balloon': 'バルーン',
    'info.close': '閉じる',                                      // ours (SSP's dialogs: 閉じる(&C))
    'launcher.call': '{name}を呼ぶ',                           // ours (after SSP's 他のゴーストを呼ぶ)
    'launcher.show': '{name}を表示',
    'launcher.someone': 'ゴースト',
    'box.input': '入力',
    'box.communicate': 'コミュニケート',                       // ours (SSP's コミュニケートボックス)
    'box.say': '話しかける',
    'box.teach': 'ティーチ',                                    // ours (UKADOC's TeachBox, Satori's ティーチボックス)
    'box.send': '送信',                                       // ours (SSP's messenger: 送信(&S) / &Send)
    'box.close': '閉じる',                                      // ours (SSP's dialogs: 閉じる(&C) / &Close)
    'scale.box.shell': 'シェル倍率',                            // DIALOG 140's title
    'scale.box.balloon': 'バルーン倍率',                        // MENU 102 [guess: what SSP titles DIALOG 140 for a balloon]
    'scale.hint': '{name} : {min}～{max} %',                    // ours, after DIALOG 140's label "シェル倍率 : "
    'scale.range': '{min}～{max} %',
  }),
});

/** Keys whose text is SSP's own in both languages (the rest are the runtime's, see the comments above). */
export const SSP_KEYS = Object.freeze(['menu.recommend', 'menu.portal', 'menu.shellScale', 'menu.balloonScale',
  'menu.scale.other', 'menu.utilities', 'menu.resetPosition', 'menu.changeGhost', 'menu.callGhost', 'menu.language', 'menu.language.system',
  'menu.iconify', 'menu.close', 'menu.closeSub', 'scale.box.shell', 'scale.box.balloon',
  'menu.shell', 'menu.dressup', 'menu.dressupExplorer', 'menu.balloon', 'menu.info',
  'menu.readme', 'menu.terms', 'menu.help', 'menu.aiGraph', 'menu.usage', 'menu.sysinfo', 'menu.leavePassive',
  'menu.charMove', 'menu.quit', 'info.readme', 'info.author', 'info.url', 'info.none', 'info.ok', 'info.terms',
  'menu.options', 'menu.preferences', 'settings.user', 'settings.name', 'settings.nickname', 'settings.birthday',
  'settings.sex', 'settings.sex.male', 'settings.sex.female', 'settings.sex.undef', 'settings.note']);
/** Keys SSP writes in English in its Japanese UI too. */
export const SAME_IN_JA = Object.freeze(['menu.language', 'menu.language.system', 'info.none', 'info.ok']);
/** Names that stay in Latin letters inside Japanese text ("Sumikaについて", "AIグラフ", "URL：", "MIDI："; UI §2.10). */
export const PROPER_NOUNS = Object.freeze(['Sumika', 'SSP', 'SHIORI', 'URL', 'AI', 'MIDI']);

/** 'ja' | 'en' for a language code; null for anything else */
export function uiLang(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return UI_LANGS.includes(s) ? s : null;
}

/** A stored choice cleaned: 'ja' | 'en' | 'system' (anything else, nothing stored included, is 'system'). */
export function normLangPref(v) {
  return uiLang(v) || 'system';
}

/**
 * "Use System Lang." in a browser: the visitor's languages (navigator.languages, else navigator.language) in their
 * order; the first that is Japanese or English decides (ja-JP → ja, en-GB → en). None of them: English [guess: what
 * SSP falls back to for an OS language it has no pack for is unknown; English is its international pack].
 */
export function systemLanguage(nav = globalThis.navigator) {
  let list = [];
  try {
    if (nav && Array.isArray(nav.languages) && nav.languages.length) list = nav.languages;
    else if (nav && nav.language) list = [nav.language];
  } catch (e) { list = []; }
  for (const tag of list) {
    const l = uiLang(String(tag || '').split(/[-_]/)[0]);
    if (l) return l;
  }
  return 'en';
}

/** The language in effect for a stored choice. */
export function resolveLanguage(pref, nav = globalThis.navigator) {
  return uiLang(pref) || systemLanguage(nav);
}

/** A string of `lang` (falls back to English, then to the key), with {name} parameters filled in. */
export function t(key, lang = 'en', params = null) {
  const table = STRINGS[uiLang(lang) || 'en'];
  const s = table[key] ?? STRINGS.en[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k]))) : s;
}

/**
 * OnLanguageChange references [UKADOC:ev]: R0 language name (descript `name`), R1 language id (`id`), R2 full path of
 * the language pack's folder, R3 its help URL. A browser has neither: '' [DECISION].
 */
export function languageRefs(lang) {
  const L = LANGUAGES[uiLang(lang) || 'en'];
  return [L.name, String(L.id), '', ''];
}
