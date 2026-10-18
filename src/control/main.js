// The control page's entry (tools/build.mjs bundles it as engines/control.<h>.js, which sumika/index.html names, deferred):
// control.js mounted on this document with this origin's localStorage (null when the browser refuses it: the page says
// the choice cannot be kept here), the browser's languages and this host's name.
import { mount } from './control.js';

let storage = null;
try {
  storage = window.localStorage || null;
} catch (e) {
  storage = null;
}
const go = () => mount(document, { storage, nav: navigator, host: location.host, win: window });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
else go();
