# Windows code page 932 as WideCharToMultiByte(932, 0) / MultiByteToWideChar(932, 0) see it (flags 0 = best fit on).
# Writes "E <cp hex> <bytes hex>" for every BMP code point that encodes to something other than '?' (0x3F),
# and "D <bytes hex> <cp hex list>" for a few invalid / odd double-byte sequences.
param([string]$Out)
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("kernel32.dll")] public static extern int WideCharToMultiByte(uint cp, uint flags, [MarshalAs(UnmanagedType.LPWStr)] string s, int n, byte[] b, int bn, IntPtr d, IntPtr u);
  [DllImport("kernel32.dll")] public static extern int MultiByteToWideChar(uint cp, uint flags, byte[] b, int bn, [Out] ushort[] w, int wn);
}
'@
Add-Type -TypeDefinition $sig
$sb = New-Object System.Text.StringBuilder
$buf = New-Object byte[] 16
for ($cp = 0x80; $cp -le 0xFFFF; $cp++) {
  if ($cp -ge 0xD800 -and $cp -le 0xDFFF) { continue }
  $s = [string][char]$cp
  $n = [W]::WideCharToMultiByte(932, 0, $s, 1, $buf, 16, [IntPtr]::Zero, [IntPtr]::Zero)
  if ($n -eq 1 -and $buf[0] -eq 0x3F) { continue }
  $h = ''
  for ($i = 0; $i -lt $n; $i++) { $h += $buf[$i].ToString('X2') }
  [void]$sb.AppendLine(('E {0:X4} {1}' -f $cp, $h))
}
$w = New-Object uint16[] 8
foreach ($pair in @(@(0x81,0x20), @(0x81,0x7F), @(0x85,0x40), @(0x86,0x40), @(0xEB,0x40), @(0xEF,0x40), @(0xFC,0x4C), @(0xFC,0xFC), @(0x81), @(0xA0), @(0x80), @(0xFD))) {
  $b = [byte[]]$pair
  $n = [W]::MultiByteToWideChar(932, 0, $b, $b.Length, $w, 8)
  $h = ''
  for ($i = 0; $i -lt $n; $i++) { $h += ([int]$w[$i]).ToString('X4') + ' ' }
  $bh = ($b | ForEach-Object { $_.ToString('X2') }) -join ''
  [void]$sb.AppendLine(('D {0} {1}' -f $bh, $h.Trim()))
}
# a surrogate pair (U+1F600)
$n = [W]::WideCharToMultiByte(932, 0, [string]([char]0xD83D) + [string]([char]0xDE00), 2, $buf, 16, [IntPtr]::Zero, [IntPtr]::Zero)
$h = ''
for ($i = 0; $i -lt $n; $i++) { $h += $buf[$i].ToString('X2') }
[void]$sb.AppendLine('S 1F600 ' + $h)
[System.IO.File]::WriteAllText($Out, $sb.ToString())
