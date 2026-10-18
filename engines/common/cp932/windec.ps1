# MultiByteToWideChar(932, 0) for every single byte 0x80-0xFF and every lead/trail pair: "D <hex> <UTF-16 units hex>"
param([string]$Out)
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class W3 {
  [DllImport("kernel32.dll")] public static extern int MultiByteToWideChar(uint cp, uint flags, byte[] b, int bn, [Out] ushort[] w, int wn);
}
'@
Add-Type -TypeDefinition $sig
$sb = New-Object System.Text.StringBuilder
$w = New-Object uint16[] 8
function Dec([byte[]]$b) {
  $n = [W3]::MultiByteToWideChar(932, 0, $b, $b.Length, $w, 8)
  $h = ''
  for ($i = 0; $i -lt $n; $i++) { $h += ([int]$w[$i]).ToString('X4') }
  $bh = ''
  foreach ($x in $b) { $bh += $x.ToString('X2') }
  [void]$sb.AppendLine("D $bh $h")
}
for ($c = 0x80; $c -le 0xFF; $c++) { Dec ([byte[]]@($c)) }
$leads = @(0x81..0x9F) + @(0xE0..0xFC)
foreach ($l in $leads) { for ($t = 0x40; $t -le 0xFC; $t++) { Dec ([byte[]]@($l, $t)) } }
[System.IO.File]::WriteAllText($Out, $sb.ToString())
