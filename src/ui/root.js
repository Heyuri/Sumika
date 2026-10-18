// One Shadow DOM root for everything the runtime draws, so host-page CSS cannot leak in or out.
export const Z_BASE = 2147483000; // characters; balloons +100; dialogs and menus +200

let root = null;

export function getRoot() {
  if (root) return root;
  const host = document.createElement('sumika-root');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:' + Z_BASE + ';';
  (document.body || document.documentElement).appendChild(host);
  root = host.attachShadow({ mode: 'open' });
  return root;
}

/** Add a stylesheet to the shadow root (each id once). */
export function addStyle(id, css) {
  const r = getRoot();
  if (r.getElementById('style-' + id)) return;
  const st = document.createElement('style');
  st.id = 'style-' + id;
  st.textContent = css;
  r.appendChild(st);
}
