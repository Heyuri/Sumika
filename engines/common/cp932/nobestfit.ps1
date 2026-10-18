# Windows code page 932 as WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS) sees it: the flag satori.dll uses
# (vendor/satoriya-shiori/satoriya/_/charset.cpp w2mb). Writes "E <cp hex> <bytes hex>" for every BMP code point that
# encodes to something other than '?' (0x3F). Same output format as bestfit.ps1 (flags 0).
param([string]$Out)
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class W2 {
  [DllImport("kernel32.dll")] public static extern int WideCharToMultiByte(uint cp, uint flags, [MarshalAs(UnmanagedType.LPWStr)] string s, int n, byte[] b, int bn, IntPtr d, IntPtr u);
}
'@
Add-Type -TypeDefinition $sig
$sb = New-Object System.Text.StringBuilder
$buf = New-Object byte[] 16
for ($cp = 0x80; $cp -le 0xFFFF; $cp++) {
  if ($cp -ge 0xD800 -and $cp -le 0xDFFF) { continue }
  $s = [string][char]$cp
  $n = [W2]::WideCharToMultiByte(932, 0x400, $s, 1, $buf, 16, [IntPtr]::Zero, [IntPtr]::Zero)
  if ($n -eq 1 -and $buf[0] -eq 0x3F) { continue }
  $h = ''
  for ($i = 0; $i -lt $n; $i++) { $h += $buf[$i].ToString('X2') }
  [void]$sb.AppendLine(('E {0:X4} {1}' -f $cp, $h))
}
[System.IO.File]::WriteAllText($Out, $sb.ToString())
