// Satori's FMO view of the ghosts on the page (EV §2.7.8): the text ssp.exe keeps in its shared "SakuraUnicode" block
// [disasm SPGhost::GetFMOString 0x623420, UpdateSakuraFileMappingImpl 0x7330D0], made from EventLoop peerInfo()
// objects. The loop hands it to a Satori engine with each request (shiori.js `fmo`), which reads it at every
// （FMOn…）, （Xの存在）, （Xのサーフェス） (Satori's satoriFMO.cpp, patch P8). Pure.

/** SSP's own folder (`.path`): the engine's /ssp/ (YAYA's MEMFS layout, yaya-wasm.md) [decision]. */
export const FMO_PATH = '/ssp/';

const clean = v => String(v ?? '').replace(/[\r\n\x01]/g, ' ');

/** A surface as SSP writes it (`%d`): a whole id >= 0, else -1 (no such scope, or hidden) [disasm 0x6E98A0]. */
function surface(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/**
 * The FMO text one ghost reads: `self` first, then `others` (peers.others(): slot order, the list otherghostname is
 * made from, so （FMO1name） and （隣で起動しているゴースト） name the same ghosts, B7). Lines `<id>.<key>\x01<value>\r\n`
 * in SSP's key order, without hwnd, kerohwnd and hwndlist (no windows in a browser) [decision]. The id is
 * `ssp_fmo_header_00000000_<n as 8 hex>`, n = 0 for self and 1, 2 … for the others: Satori sorts its entries by id,
 * so they keep slot order [decision: SSP's order is its window handles'], and it finds itself by `ghostpath` + its
 * ghost/master/ folder (`/`: Satori's base folder is /ghost/master/). CR, LF and \x01 in a value become a space; a
 * line whose value is empty is left out (Satori drops it anyway) [src SakuraFMO.cpp].
 * @param {{id?:string, name?:string, sakuraName?:string, keroName?:string, surfaces?:number[]}} self
 * @param {object[]} [others]
 * @returns {string}
 */
export function fmoText(self, others = []) {
  const list = [self, ...(Array.isArray(others) ? others : [])];
  let out = '';
  list.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const id = `ssp_fmo_header_00000000_${i.toString(16).padStart(8, '0')}`;
    const s = Array.isArray(p.surfaces) ? p.surfaces : [];
    const rows = [
      ['path', FMO_PATH],
      ['name', p.sakuraName],
      ['keroname', p.keroName],
      ['sakura.surface', surface(s[0])],
      ['kero.surface', surface(s[1])],
      ['ghostpath', i === 0 ? '/' : `${FMO_PATH}ghost/${clean(p.id)}/`],
      ['fullname', p.name],
      ['modulestate', 'shiori:running'],
    ];
    for (const [key, v] of rows) {
      const value = clean(v);
      if (value !== '') out += `${id}.${key}\x01${value}\r\n`;
    }
  });
  return out;
}
