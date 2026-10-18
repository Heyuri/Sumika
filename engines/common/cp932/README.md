# Windows code page 932, measured

What `engines/common/gen_cp932.py --verify engines/common/cp932` compares its tables with. Made on Windows 11
(2026-10-08) with Windows PowerShell 5.1, each script run as `powershell -File <script> -Out <file>`:

- `windec.ps1` → `windec.txt`: `MultiByteToWideChar(932, 0)` of every byte 0x80-0xFF and every lead/trail pair
  (`D <bytes> <UTF-16 units>`).
- `nobestfit.ps1` → `win932_nobestfit.txt`: `WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS)` (satori.dll's flag) of
  every BMP code point from U+0080 (`E <cp> <bytes>`; the ones that become `?` are left out).
- `bestfit.ps1` → `win932_bestfit.txt`: the same with flags 0 (best fit, yaya.dll's), plus a few invalid pairs (`D`)
  and a surrogate pair (`S`). It was written as `win932.txt` and renamed.

The dumps are data: re-run the scripts only to re-measure on another Windows version.
