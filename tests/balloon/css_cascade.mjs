// A tiny CSS cascade for the fake DOM: enough to compute what a stylesheet of src/balloon/ does to an element
// (selectors made of tag, .class, [attr] and the '>' / ' ' combinators; !important; specificity; inline style; the UA
// rule [hidden]{display:none}). Catches author rules that silently override the `hidden` attribute.

/** @returns {{sel:string, spec:number[], decls:Map<string,{value:string, important:boolean}>, order:number}[]} */
export function parseRules(css) {
  const out = [];
  let src = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  // drop @-blocks (keyframes) with their nested braces
  for (let i; (i = src.indexOf('@')) >= 0;) {
    let j = src.indexOf('{', i), depth = 0, k = j;
    for (; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) break; }
    src = src.slice(0, i) + src.slice(k + 1);
  }
  let order = 0;
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    for (const d of m[2].split(';')) {
      const c = d.indexOf(':');
      if (c < 0) continue;
      let value = d.slice(c + 1).trim();
      const important = /!\s*important$/.test(value);
      if (important) value = value.replace(/!\s*important$/, '').trim();
      decls.set(d.slice(0, c).trim(), { value, important });
    }
    for (const sel of m[1].split(',')) out.push({ sel: sel.trim(), spec: specificity(sel), decls, order: order++ });
  }
  return out;
}

function compounds(sel) {
  // [[combinator, compound], ...] from left to right; combinator of the first one is null
  const parts = [];
  for (const m of sel.trim().replace(/\s*>\s*/g, '>').matchAll(/([>\s]?)([^>\s]+)/g)) parts.push([parts.length ? m[1] || ' ' : null, m[2]]);
  return parts;
}

function specificity(sel) {
  const s = [0, 0, 0];
  for (const [, c] of compounds(sel)) {
    for (const m of c.matchAll(/\.[\w-]+|\[[^\]]+\]|#[\w-]+|^[a-zA-Z][\w-]*/g)) {
      if (m[0][0] === '#') s[0]++;
      else if (m[0][0] === '.' || m[0][0] === '[') s[1]++;
      else s[2]++;
    }
  }
  return s;
}

function matchCompound(el, c) {
  if (!el || !el.tagName) return false;
  for (const m of c.matchAll(/\.([\w-]+)|\[([\w-]+)\]|^([a-zA-Z][\w-]*)/g)) {
    if (m[1] && !String(el.className || '').split(/\s+/).includes(m[1]) && !(el.classList && el.classList.contains(m[1]))) return false;
    if (m[2] && !(m[2] === 'hidden' ? el.hidden : el.attrs && m[2] in el.attrs)) return false;
    if (m[3] && el.tagName.toLowerCase() !== m[3].toLowerCase()) return false;
  }
  return true;
}

function matches(el, sel) {
  const parts = compounds(sel);
  const test = (node, i) => {
    if (!matchCompound(node, parts[i][1])) return false;
    if (i === 0) return true;
    const comb = parts[i][0];
    if (comb === '>') return test(node.parent, i - 1);
    for (let a = node.parent; a; a = a.parent) if (test(a, i - 1)) return true;
    return false;
  };
  return test(el, parts.length - 1);
}

/** Computed value of a property on a fake element under the given stylesheets (null = not set by anyone). */
export function computed(el, prop, ...sheets) {
  let best = null;
  const rank = (imp, spec, order, inline) => [imp ? 1 : 0, inline ? 1 : 0, ...spec, order];
  const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  let order = 0;
  for (const css of sheets) {
    for (const r of parseRules(css)) {
      order++;
      const d = r.decls.get(prop);
      if (!d || !matches(el, r.sel)) continue;
      const k = rank(d.important, r.spec, order, false);
      if (!best || better(k, best.k)) best = { k, value: d.value };
    }
  }
  const camel = prop.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const inline = el.style && el.style[camel];
  if (inline) {
    const k = rank(false, [0, 0, 0], 0, true);
    if (!best || better(k, best.k)) best = { k, value: inline };
  }
  if (best) return best.value;
  if (prop === 'display' && el.hidden) return 'none'; // UA stylesheet
  return null;
}

/** All stylesheets the code added to a (fake) shadow root. */
export function sheetsOf(root) {
  return root.children.filter(c => c.tagName === 'STYLE').map(c => c.textContent);
}
