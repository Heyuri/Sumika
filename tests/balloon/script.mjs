// A small SakuraScript tokenizer and "player" used only by the balloon tests and the dev page.
// It maps the balloon-related tags onto the BalloonView API the way src/sakura/player.js is expected to (CONTRACTS).
// No waits, no SHIORI: every script is laid out instantly.

/** @returns {{type:'text', text:string}|{type:'tag', name:string, args:string[]|null}} [] */
export function tokenize(s) {
  const out = [];
  let text = '';
  let i = 0;
  const flush = () => { if (text) { out.push({ type: 'text', text }); text = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\') { text += c; i++; continue; }
    const n = s[i + 1];
    if (n === '\\' || n === '%' || n === ']') { text += n; i += 2; continue; }
    if (n === undefined) { i++; continue; }
    let name, j = i + 1;
    if (s[j] === '_' && s[j + 1] === '_') { name = '__' + s[j + 2]; j += 3; }
    else if (s[j] === '_') { name = '_' + s[j + 1]; j += 2; }
    else { name = s[j]; j++; }
    if (name === '_?' || name === '_!') {
      const end = s.indexOf('\\' + name, j);
      text += end < 0 ? s.slice(j) : s.slice(j, end);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    flush();
    let args = null;
    if (s[j] === '[') {
      j++;
      args = [];
      let cur = '', q = false;
      while (j < s.length) {
        const ch = s[j];
        if (q) {
          if (ch === '"') { if (s[j + 1] === '"') { cur += '"'; j += 2; continue; } q = false; j++; continue; }
          cur += ch; j++; continue;
        }
        if (ch === '"' && cur.trim() === '') { q = true; cur = ''; j++; continue; }
        if (ch === '\\' && (s[j + 1] === ']' || s[j + 1] === '\\')) { cur += s[j + 1]; j += 2; continue; }
        if (ch === ',') { args.push(cur); cur = ''; j++; continue; }
        if (ch === ']') { args.push(cur); j++; break; }
        cur += ch; j++;
      }
    } else if ('sbpwi'.includes(name) && /[0-9]/.test(s[j] || '')) {
      args = [s[j]];
      j++;
    }
    out.push({ type: 'tag', name, args });
    i = j;
  }
  flush();
  return out;
}

const NON_CONTENT = new Set(['0', '1', 'h', 'u', 'p', 's', 'b', 'w', '_w', '!', '_q', 't', '*', 'i']);

/**
 * Lay a script out on a Balloons-like object ({get(scope), beginScript(append)}).
 * @returns {{scope:number, tokens:number}}
 */
export function play(balloons, script, { tokens } = {}) {
  const toks = tokens || tokenize(script);
  // \C counts as append when only non-content tags come before it (SUM §2.2)
  let append = false;
  for (const t of toks) {
    if (t.type === 'tag' && t.name === 'C') { append = true; break; }
    if (t.type === 'text' || !NON_CONTENT.has(t.name)) break;
  }
  balloons.beginScript(append);
  let scope = 0;
  let v = balloons.get(0);
  const setScope = n => { scope = n; v = balloons.get(n); };
  for (const t of toks) {
    if (t.type === 'text') { v.write(t.text); continue; }
    const a = t.args || [];
    switch (t.name) {
      case '0': case 'h': setScope(0); break;
      case '1': case 'u': setScope(1); break;
      case 'p': { const n = parseInt(a[0], 10); if (n >= 0) setScope(n); break; }
      case 'b': v.setKind(parseInt(a[0], 10)); break;
      case 'n':
        if (!t.args) v.newline(1);
        else if (a[0] === 'half') v.newline(0.5);
        else if (/^-?\d+$/.test(a[0])) v.newline(+a[0] / 100);
        else v.newline(1);
        break;
      case '_n': v.toggleNoWrap(); break;
      case '_l': v.locate(a[0] ?? '', a[1] ?? ''); break;
      case '_b': v.image(a[0], a[1], a[2], a.slice(3)); break;
      case 'c':
        if (!t.args) v.clear();
        else if (a[0] === 'char') v.clearChars(+a[1], a[2]);
        else if (a[0] === 'line') v.clearLines(+a[1], a[2]);
        break;
      case 'f': v.setFont(a[0], a.slice(1).join(',')); break;
      case 'q': if (t.args) v.addChoice(a[0], { kind: 'choice', id: a[1], refs: a.slice(2) }); break;
      case '__q': if (t.args) v.beginLink({ kind: 'choice', id: a[0], refs: a.slice(1) }); else v.endLink(); break;
      case '_a': if (t.args) v.beginLink({ kind: 'anchor', id: a[0], refs: a.slice(1) }); else v.endLink(); break;
      case '!':
        if (a[0] === '*') v.marker();
        else if (a[0] === 'set' && a[1] === 'autoscroll') v.setAutoscroll(a[2] !== 'disable');
        break;
      case 'x': break;
      case 'e': return { scope, tokens: toks.length };
      default: break;
    }
  }
  return { scope, tokens: toks.length };
}
