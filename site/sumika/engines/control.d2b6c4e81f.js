(() => {
  // src/core/log.js
  var LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  var level = LEVELS.warn;
  try {
    if (typeof location !== "undefined" && /[?&]sumika-debug\b/.test(location.search)) level = LEVELS.debug;
  } catch (e) {
  }

  // src/core/ghostset.js
  var isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  function uniqueIds(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const id of list) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
    return out;
  }
  function markerGhosts(m) {
    if (!isObj(m)) return [];
    return uniqueIds(Array.isArray(m.ghosts) ? m.ghosts : [m.ghost]);
  }
  function validCarry(e) {
    if (!isObj(e)) return false;
    if (e.kind === "change") return true;
    if (e.kind === "call") return isObj(e.call);
    return e.kind === "after" && (e.of === "call" || e.of === "change");
  }
  function markerCarry(m) {
    if (!isObj(m)) return {};
    if (isObj(m.carry)) {
      const out = {};
      for (const [id, e] of Object.entries(m.carry)) if (id && validCarry(e)) out[id] = e;
      return out;
    }
    if (m.pending === true && typeof m.ghost === "string" && m.ghost) {
      return { [m.ghost]: { kind: "change", change: isObj(m.change) ? m.change : null } };
    }
    return {};
  }

  // src/core/schema.js
  var SCHEMA = Object.freeze({ state: 1, prefs: 1, marker: 2, files: 1, drops: 1, choice: 1 });
  var isObj2 = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  function markerV1toV2(m) {
    if (!isObj2(m)) return m;
    const out = { ...m, ghosts: markerGhosts(m) };
    const carry = markerCarry(m);
    if (Object.keys(carry).length) out.carry = carry;
    return out;
  }
  var STEPS = Object.freeze({ state: {}, prefs: {}, marker: { 1: markerV1toV2 }, files: {}, drops: {}, choice: {} });
  function versionOf(v) {
    return Number.isInteger(v) && v >= 1 ? v : 1;
  }
  function upgrade(kind, rec, v, steps = STEPS[kind] || {}, to = SCHEMA[kind] || 1) {
    let n = versionOf(v);
    if (n > to) return { rec, v: n, newer: true };
    let out = rec;
    const from = n;
    for (; n < to; n++) if (typeof steps[n] === "function") out = steps[n](out);
    if (n > from && isObj2(out)) out = { ...out, v: n };
    return { rec: out, v: n, newer: false };
  }

  // src/core/choice.js
  var CHOICE_KEY = "sumika:choice";
  var CHOICES = Object.freeze(["on", "off"]);
  var DEFAULT_STATES = Object.freeze(["enabled", "tucked", "off"]);
  var isObj3 = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  function parseChoice(text2) {
    let raw = null;
    try {
      raw = text2 == null ? null : JSON.parse(text2);
    } catch (e) {
      raw = null;
    }
    if (!isObj3(raw)) return { choice: null, newer: false, rec: null };
    const up = upgrade("choice", raw, raw.v);
    const rec = isObj3(up.rec) ? up.rec : {};
    return { choice: CHOICES.includes(rec.choice) ? rec.choice : null, newer: up.newer, rec };
  }
  function readChoice(storage2) {
    let text2;
    try {
      if (!storage2) return { choice: null, newer: false, blocked: true };
      text2 = storage2.getItem(CHOICE_KEY);
    } catch (e) {
      return { choice: null, newer: false, blocked: true };
    }
    const r = parseChoice(text2);
    return { choice: r.choice, newer: r.newer, blocked: false };
  }
  function saveChoice(storage2, choice) {
    if (choice !== null && !CHOICES.includes(choice)) throw new TypeError(`no such choice: ${choice}`);
    try {
      const cur = parseChoice(storage2.getItem(CHOICE_KEY));
      if (cur.newer) return "newer";
      if (choice === null) storage2.removeItem(CHOICE_KEY);
      else storage2.setItem(CHOICE_KEY, JSON.stringify({ ...cur.rec || {}, choice, v: SCHEMA.choice }));
      return "saved";
    } catch (e) {
      return "failed";
    }
  }

  // src/control/control.js
  var STRINGS = Object.freeze({
    en: Object.freeze({
      title: "Sumika in this browser",
      intro: "Sumika shows ukagaka ghosts, characters that talk and react to your clicks, on web pages. Choose here whether they appear for you.",
      legend: "Show Sumika",
      "choice.site": "Site default",
      "choice.site.hint": "Each page shows Sumika as its site set it up: on, waiting as a button in a corner, or off.",
      "choice.on": "On",
      "choice.on.hint": "The ghosts appear on every page that has Sumika, also where the site would keep them off or behind a button. On a phone, some pages still show a button first.",
      "choice.off": "Off",
      "choice.off.hint": "No ghost and no button on any page. What the ghosts remember stays in this browser, so they carry on when you turn Sumika on again.",
      where: "Your choice is kept in this browser only, for the pages that use Sumika from {host}. Pages you open or reload from now on follow it; a page already open stays as it is.",
      "status.saved": "Saved: {choice}. Pages you open or reload from now on follow it.",
      "status.failed": "Your choice could not be saved in this browser, so nothing changed.",
      "status.blocked": "This browser does not let this page keep a choice, so each page follows its site's setting.",
      "status.newer": "Your choice was saved by a newer version of this page. Reload this page to change it."
    }),
    ja: Object.freeze({
      title: "\u3053\u306E\u30D6\u30E9\u30A6\u30B6\u3067\u306E Sumika",
      intro: "Sumika \u306F\u3001\u8A71\u3057\u305F\u308A\u30AF\u30EA\u30C3\u30AF\u306B\u53CD\u5FDC\u3057\u305F\u308A\u3059\u308B\u4F3A\u304B\u306E\u30B4\u30FC\u30B9\u30C8\u3092\u30A6\u30A7\u30D6\u30DA\u30FC\u30B8\u306B\u8868\u793A\u3057\u307E\u3059\u3002\u3042\u306A\u305F\u306E\u30D6\u30E9\u30A6\u30B6\u3067\u8868\u793A\u3059\u308B\u304B\u3069\u3046\u304B\u3092\u3001\u3053\u3053\u3067\u9078\u3079\u307E\u3059\u3002",
      legend: "Sumika \u306E\u8868\u793A",
      "choice.site": "\u30B5\u30A4\u30C8\u306E\u8A2D\u5B9A\u3069\u304A\u308A",
      "choice.site.hint": "\u5404\u30DA\u30FC\u30B8\u3067\u3001\u30B5\u30A4\u30C8\u304C\u6C7A\u3081\u305F\u3068\u304A\u308A\u306B\u8868\u793A\u3057\u307E\u3059\uFF08\u8868\u793A\u3059\u308B\u3001\u9685\u306E\u30DC\u30BF\u30F3\u3067\u5F85\u3064\u3001\u8868\u793A\u3057\u306A\u3044\uFF09\u3002",
      "choice.on": "\u30AA\u30F3",
      "choice.on.hint": "Sumika \u306E\u3042\u308B\u3059\u3079\u3066\u306E\u30DA\u30FC\u30B8\u3067\u30B4\u30FC\u30B9\u30C8\u3092\u8868\u793A\u3057\u307E\u3059\u3002\u30B5\u30A4\u30C8\u304C\u8868\u793A\u3057\u306A\u3044\u8A2D\u5B9A\u3084\u30DC\u30BF\u30F3\u306B\u3057\u3066\u3044\u308B\u30DA\u30FC\u30B8\u3067\u3082\u8868\u793A\u3057\u307E\u3059\u3002\u30B9\u30DE\u30FC\u30C8\u30D5\u30A9\u30F3\u3067\u306F\u3001\u6700\u521D\u306B\u30DC\u30BF\u30F3\u3092\u8868\u793A\u3059\u308B\u30DA\u30FC\u30B8\u3082\u3042\u308A\u307E\u3059\u3002",
      "choice.off": "\u30AA\u30D5",
      "choice.off.hint": "\u3069\u306E\u30DA\u30FC\u30B8\u306B\u3082\u3001\u30B4\u30FC\u30B9\u30C8\u3082\u30DC\u30BF\u30F3\u3082\u8868\u793A\u3057\u307E\u305B\u3093\u3002\u30B4\u30FC\u30B9\u30C8\u306E\u8A18\u61B6\u306F\u3053\u306E\u30D6\u30E9\u30A6\u30B6\u306B\u6B8B\u308B\u306E\u3067\u3001\u30AA\u30F3\u306B\u623B\u3059\u3068\u7D9A\u304D\u304B\u3089\u59CB\u307E\u308A\u307E\u3059\u3002",
      where: "\u3053\u306E\u9078\u629E\u306F\u3053\u306E\u30D6\u30E9\u30A6\u30B6\u306B\u3060\u3051\u4FDD\u5B58\u3055\u308C\u3001{host} \u306E Sumika \u3092\u4F7F\u3046\u30DA\u30FC\u30B8\u304C\u5F93\u3044\u307E\u3059\u3002\u3053\u308C\u304B\u3089\u958B\u304F\u30DA\u30FC\u30B8\u3084\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u305F\u30DA\u30FC\u30B8\u304B\u3089\u6709\u52B9\u306B\u306A\u308A\u3001\u4ECA\u958B\u3044\u3066\u3044\u308B\u30DA\u30FC\u30B8\u306F\u305D\u306E\u307E\u307E\u3067\u3059\u3002",
      "status.saved": "\u4FDD\u5B58\u3057\u307E\u3057\u305F\uFF08{choice}\uFF09\u3002\u3053\u308C\u304B\u3089\u958B\u304F\u30DA\u30FC\u30B8\u3084\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u305F\u30DA\u30FC\u30B8\u304B\u3089\u6709\u52B9\u306B\u306A\u308A\u307E\u3059\u3002",
      "status.failed": "\u3053\u306E\u30D6\u30E9\u30A6\u30B6\u306B\u9078\u629E\u3092\u4FDD\u5B58\u3067\u304D\u306A\u304B\u3063\u305F\u305F\u3081\u3001\u4F55\u3082\u5909\u308F\u3063\u3066\u3044\u307E\u305B\u3093\u3002",
      "status.blocked": "\u3053\u306E\u30D6\u30E9\u30A6\u30B6\u3067\u306F\u3001\u3053\u306E\u30DA\u30FC\u30B8\u304C\u9078\u629E\u3092\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093\u3002\u5404\u30DA\u30FC\u30B8\u306F\u30B5\u30A4\u30C8\u306E\u8A2D\u5B9A\u3069\u304A\u308A\u306B\u306A\u308A\u307E\u3059\u3002",
      "status.newer": "\u3053\u306E\u9078\u629E\u306F\u3001\u3053\u306E\u30DA\u30FC\u30B8\u306E\u65B0\u3057\u3044\u7248\u3067\u4FDD\u5B58\u3055\u308C\u3066\u3044\u307E\u3059\u3002\u5909\u3048\u308B\u306B\u306F\u3001\u3053\u306E\u30DA\u30FC\u30B8\u3092\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
    })
  });
  var OPTIONS = Object.freeze(["site", "on", "off"]);
  function pageLanguage(nav) {
    let list = [];
    try {
      if (nav && Array.isArray(nav.languages) && nav.languages.length) list = nav.languages;
      else if (nav && nav.language) list = [nav.language];
    } catch (e) {
      list = [];
    }
    for (const tag of list) {
      const l = String(tag || "").split(/[-_]/)[0].trim().toLowerCase();
      if (l === "ja" || l === "en") return l;
    }
    return "en";
  }
  function text(key, lang, params = null) {
    const s = (STRINGS[lang] || STRINGS.en)[key] ?? STRINGS.en[key] ?? key;
    return params ? s.replace(/\{(\w+)\}/g, (m, k) => params[k] == null ? m : String(params[k])) : s;
  }
  var optionOf = (choice) => choice === "on" || choice === "off" ? choice : "site";
  var choiceOf = (option) => option === "on" || option === "off" ? option : null;
  function viewOf(read) {
    if (read.blocked) return { option: "site", disabled: true, status: "status.blocked" };
    if (read.newer) return { option: optionOf(read.choice), disabled: true, status: "status.newer" };
    return { option: optionOf(read.choice), disabled: false, status: null };
  }
  function pick(storage2, option, lang) {
    const outcome = storage2 ? saveChoice(storage2, choiceOf(option)) : "failed";
    if (outcome === "saved") {
      return { outcome, option, status: text("status.saved", lang, { choice: text(`choice.${option}`, lang) }) };
    }
    const now = readChoice(storage2);
    return { outcome, option: optionOf(now.choice), status: text(outcome === "newer" ? "status.newer" : "status.failed", lang) };
  }
  function mount(doc, { storage: storage2, nav, host, win = null }) {
    const lang = pageLanguage(nav);
    const el = (tag, props = {}, kids = []) => {
      const e = doc.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === "text") e.textContent = v;
        else if (k === "attrs") for (const [a, x] of Object.entries(v)) e.setAttribute(a, x);
        else e[k] = v;
      }
      for (const c of kids) e.appendChild(c);
      return e;
    };
    if (doc.documentElement) doc.documentElement.setAttribute("lang", lang);
    doc.title = text("title", lang);
    const view = viewOf(readChoice(storage2));
    const status = el("p", { className: "status", attrs: { role: "status", "aria-live": "polite" }, text: view.status ? text(view.status, lang) : "" });
    const inputs = {};
    const rows = OPTIONS.map((o) => {
      const id = `sumika-choice-${o}`;
      const input = el("input", {
        type: "radio",
        name: "sumika-choice",
        value: o,
        id,
        checked: o === view.option,
        disabled: view.disabled,
        attrs: { "aria-labelledby": `${id}-name`, "aria-describedby": `${id}-hint` }
      });
      inputs[o] = input;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const r = pick(storage2, o, lang);
        for (const k of OPTIONS) inputs[k].checked = k === r.option;
        status.textContent = r.status;
      });
      return el("label", { className: "option", attrs: { for: id } }, [
        input,
        el("span", { className: "name", id: `${id}-name`, text: text(`choice.${o}`, lang) }),
        el("span", { className: "hint", id: `${id}-hint`, text: text(`choice.${o}.hint`, lang) })
      ]);
    });
    const main = el("main", {}, [
      el("h1", { text: text("title", lang) }),
      el("p", { text: text("intro", lang) }),
      el("fieldset", {}, [el("legend", { text: text("legend", lang) }), ...rows]),
      status,
      el("p", { className: "where", text: text("where", lang, { host }) })
    ]);
    doc.body.appendChild(main);
    if (win && typeof win.addEventListener === "function" && !view.disabled) {
      win.addEventListener("storage", (ev) => {
        if (!ev || ev.key !== CHOICE_KEY && ev.key !== null) return;
        const now = viewOf(readChoice(storage2));
        for (const k of OPTIONS) {
          inputs[k].checked = k === now.option;
          inputs[k].disabled = now.disabled;
        }
        status.textContent = now.status ? text(now.status, lang) : "";
      });
    }
    return { lang, inputs, status };
  }

  // src/control/main.js
  var storage = null;
  try {
    storage = window.localStorage || null;
  } catch (e) {
    storage = null;
  }
  var go = () => mount(document, { storage, nav: navigator, host: location.host, win: window });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true });
  else go();
})();
//# sourceMappingURL=control.d2b6c4e81f.js.map
