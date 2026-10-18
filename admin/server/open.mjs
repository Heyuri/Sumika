// Opens the default browser at the program's address (CONTRACTS "Admin API" opening): Windows' `rundll32.exe
// url.dll,FileProtocolHandler <url>` (no cmd, so `&` and `^` in a URL need no quoting), macOS `open`, Linux
// `xdg-open`; the compiled program may run exactly these (--allow-run). A failure is harmless: the address is on the
// console.
import { spawn } from 'node:child_process';

/** The command and arguments that open a URL on a platform. */
export function opener(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** Opens url in the default browser, not waiting for it; false when it could not be started. */
export function openBrowser(url, { platform = process.platform } = {}) {
  const [cmd, args] = opener(url, platform);
  try {
    const D = globalThis.Deno;
    if (D && typeof D.Command === 'function') {
      const child = new D.Command(cmd, { args, stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
      child.status.catch(() => {});
      if (typeof child.unref === 'function') child.unref();
      return true;
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}
