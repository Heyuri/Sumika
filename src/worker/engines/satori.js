// Satori (里々), compiled from vendor/satoriya-shiori by engines/satori/build.py.
import { EmscriptenShiori } from './emscripten.js';

export class SatoriEngine extends EmscriptenShiori {
  async factory() {
    if (typeof self.createSatori !== 'function') importScripts(this.engineUrl);
    return self.createSatori;
  }

  /**
   * Patch P7 (SUMMARY §2.1): with opts.bootEpochMs (epoch ms of the ghost's last cold boot), Satori's uptime clock
   * counts from it, so （単純起動秒）/（起動時…） survive page loads; satori_load_resume moves the load to that zero.
   */
  init(files, persisted, opts = {}) {
    if (this.M && opts.bootEpochMs > 0) this.M.bootEpochMs = opts.bootEpochMs;
    return super.init(files, persisted, opts);
  }

  /**
   * Patch P8: the page's FMO text (SSP's "SakuraUnicode" lines, src/core/fmo.js), read by （FMOn…）, （Xの存在） and
   * （Xのサーフェス） at each use. Anything but a string withdraws it: Satori then keeps the list it read last.
   */
  setFmo(text) {
    if (!this.M) return;
    if (typeof text === 'string') this.M.fmoText = text;
    else delete this.M.fmoText;
  }

  /** satori_save (patch P3): write satori_savedata.txt without unloading. */
  save() {
    if (typeof this.M._satori_save !== 'function') return false;
    try {
      return this.M._satori_save() === 1;
    } catch (e) {
      this.log('error', `satori_save: ${e}`);
      return false;
    }
  }

  /** Random-talk countdown and seconds since the last talk (patch P6). */
  getVolatileState() {
    const M = this.M;
    if (typeof M._satori_get_talk_count !== 'function') return null;
    return { talkCount: M._satori_get_talk_count(), sinceLastTalk: M._satori_get_since_last_talk(), at: Date.now() };
  }

  /** Restore it after a page navigation; time spent away counts as idle time. */
  setVolatileState(s) {
    if (!s || typeof this.M._satori_set_talk_state !== 'function') return;
    const away = Math.max(0, Math.floor((Date.now() - (s.at || Date.now())) / 1000));
    this.M._satori_set_talk_state(Math.max(0, (s.talkCount | 0) - away), (s.sinceLastTalk | 0) + away);
  }
}
