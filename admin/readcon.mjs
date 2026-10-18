// Reads the text of another program's console window, for the build's smoke (admin/server/drive.mjs startInConsole:
// what a program that stopped answering shows there, such as Deno's "Allow? [y/n/A]"). A Deno script (FFI to
// kernel32; Windows only), run with the pinned deno.exe:
//   deno run --no-config --no-prompt --allow-ffi --allow-write=<out> admin/readcon.mjs <pid> <out>
// It leaves its own console (FreeConsole), attaches to the program's (AttachConsole), reads every line of the screen
// buffer up to the cursor (ReadConsoleOutputCharacterW on CONOUT$) and writes {width, lines} or {error} as JSON to
// <out>. Its own stdout and stderr must not be that console (pipes are fine: drive.mjs's spawn). Not part of the
// program; never published.
/* global Deno */
const pid = Number(Deno.args[0]);
const out = Deno.args[1];
const k = Deno.dlopen('kernel32.dll', {
  FreeConsole: { parameters: [], result: 'i32' },
  AttachConsole: { parameters: ['u32'], result: 'i32' },
  GetLastError: { parameters: [], result: 'u32' },
  CreateFileW: { parameters: ['buffer', 'u32', 'u32', 'pointer', 'u32', 'u32', 'pointer'], result: 'pointer' },
  CloseHandle: { parameters: ['pointer'], result: 'i32' },
  GetConsoleScreenBufferInfo: { parameters: ['pointer', 'buffer'], result: 'i32' },
  ReadConsoleOutputCharacterW: { parameters: ['pointer', 'buffer', 'u32', 'u32', 'buffer'], result: 'i32' },
});
const GENERIC_RW = 0xC0000000, SHARE_RW = 3, OPEN_EXISTING = 3;

/** A NUL-terminated UTF-16 string's bytes. */
function wide(s) {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return new Uint8Array(a.buffer);
}

let answer;
k.symbols.FreeConsole();
if (!Number.isInteger(pid) || pid <= 0 || !k.symbols.AttachConsole(pid)) {
  answer = { error: `AttachConsole(${pid}) failed (${k.symbols.GetLastError()})` };
} else {
  const h = k.symbols.CreateFileW(wide('CONOUT$'), GENERIC_RW, SHARE_RW, null, OPEN_EXISTING, 0, null);
  // CONSOLE_SCREEN_BUFFER_INFO: dwSize (X, Y), dwCursorPosition (X, Y), …: 22 bytes
  const info = new Uint8Array(22);
  if (!k.symbols.GetConsoleScreenBufferInfo(h, info)) {
    answer = { error: `GetConsoleScreenBufferInfo failed (${k.symbols.GetLastError()})` };
  } else {
    const dv = new DataView(info.buffer);
    const width = dv.getInt16(0, true), cursorY = dv.getInt16(6, true);
    const lines = [];
    for (let y = 0; y <= cursorY; y++) {
      const buf = new Uint16Array(width);
      const n = new Uint32Array(1);
      // a COORD by value: X in the low 16 bits, Y in the high 16
      k.symbols.ReadConsoleOutputCharacterW(h, new Uint8Array(buf.buffer), width, (y << 16) >>> 0, new Uint8Array(n.buffer));
      lines.push(String.fromCharCode(...buf.subarray(0, n[0])).trimEnd());
    }
    answer = { width, lines };
  }
  k.symbols.CloseHandle(h);
  k.symbols.FreeConsole();
}
Deno.writeTextFileSync(out, JSON.stringify(answer));
