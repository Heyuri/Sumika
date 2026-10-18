// DOM helpers of the admin page. The page's CSP forbids style attributes (CONTRACTS "Admin API"): looks come from
// classes in style.css, state from attributes (hidden, aria-*). Nothing here runs at import.
import { t, template, paramText } from './strings.js';

/**
 * An element: el('button', {class: 'x', onclick: f, 'aria-label': 'y'}, 'text', node, …). Attribute values true add
 * the bare attribute, false / null / undefined leave it out; `on…` functions become listeners.
 */
export function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'multiple') node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  return node;
}

/** Appends text and nodes (arrays flattened, null skipped). */
export function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Empties a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replaces a node's content. */
export const fill = (node, ...children) => append(clear(node), children);

/** A path, a file name or code as the page shows it. */
export const code = text => el('code', null, String(text));

/** Text a ghost provides (a name, a balloon's name, readme lines): never in the UI language (lang=""). */
export const ghostText = (text, tag = 'span') => el(tag, { lang: '' }, String(text));

/**
 * A string of the table as nodes: its {parameters} given as nodes (code(), ghostText()) stay nodes, others text.
 * @returns {Node[]}
 */
export function tNodes(key, lang, params = {}) {
  const out = [];
  for (const part of template(key, lang).split(/(\{\w+\})/)) {
    if (!part) continue;
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) {
      out.push(document.createTextNode(part));
      continue;
    }
    const v = params ? params[m[1]] : undefined;
    out.push(v instanceof Node ? v : document.createTextNode(paramText(params, m[1]) ?? part));
  }
  return out;
}

/** The template's fixed text in `lang`: data-t (text), data-t-aria-label, data-t-title, data-t-placeholder. */
export function applyStrings(root, lang) {
  for (const n of root.querySelectorAll('[data-t]')) n.textContent = t(n.getAttribute('data-t'), lang);
  for (const a of ['aria-label', 'title', 'placeholder']) {
    for (const n of root.querySelectorAll(`[data-t-${a}]`)) n.setAttribute(a, t(n.getAttribute(`data-t-${a}`), lang));
  }
}

