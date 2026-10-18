# SHIORI test harness: loads a ghost's real 32-bit SHIORI DLL (satori.dll unless -Dll says otherwise) and sends requests.
# Made the recorded answers of tests/corpus/ (ghost content: not part of this repository). Windows only. Run with 32-bit PowerShell:
#   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -File dll_harness.ps1 -GhostDir <dir\> -Requests <file> -Out <file> [-Dll yaya.dll] [-Charset UTF-8]
# Requests file (UTF-8): one request per line: ID<TAB>Ref0<TAB>Ref1...  ; lines starting with '#' ignored.
#   Prefix the ID with '!' to send NOTIFY instead of GET. -Charset (Shift_JIS or UTF-8, default Shift_JIS) is the requests'
#   Charset header and how requests and replies are encoded (YAYA's templates answer in the request's charset).
param([string]$GhostDir, [string]$Requests, [string]$Out, [string]$Dll = 'satori.dll', [string]$Charset = 'Shift_JIS')

$code = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ShioriHost {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryW(string p);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr GetProcAddress(IntPtr m, string n);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint f, UIntPtr n);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetDllDirectoryW(string p);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetCurrentDirectoryW(string p);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int LoadFn(IntPtr h, int len);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int UnloadFn();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr RequestFn(IntPtr h, ref int len);

    static LoadFn load; static UnloadFn unload; static RequestFn request;
    static Encoding sjis = Encoding.GetEncoding(932);
    public static Encoding Enc = sjis;      // requests and replies (-Charset); the load path stays Shift_JIS
    public static List<string> Dialogs = new List<string>();

    static IntPtr Alloc(byte[] b) {
        IntPtr p = GlobalAlloc(0, (UIntPtr)(uint)(b.Length + 1));
        Marshal.Copy(b, 0, p, b.Length);
        Marshal.WriteByte(p, b.Length, 0);
        return p;
    }

    public static int Load(string dir, string dll) {
        SetDllDirectoryW(dir);
        SetCurrentDirectoryW(dir);
        IntPtr m = LoadLibraryW(dir + dll);
        if (m == IntPtr.Zero) throw new Exception("LoadLibrary failed: " + Marshal.GetLastWin32Error());
        load = (LoadFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(m, "load"), typeof(LoadFn));
        unload = (UnloadFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(m, "unload"), typeof(UnloadFn));
        request = (RequestFn)Marshal.GetDelegateForFunctionPointer(GetProcAddress(m, "request"), typeof(RequestFn));
        byte[] b = sjis.GetBytes(dir);
        return load(Alloc(b), b.Length);
    }

    public static string Request(string req) {
        byte[] b = Enc.GetBytes(req);
        int len = b.Length;
        IntPtr r = request(Alloc(b), ref len);
        if (r == IntPtr.Zero) return null;
        byte[] o = new byte[len];
        Marshal.Copy(r, o, 0, len);
        GlobalFree(r);
        return Enc.GetString(o);
    }

    public static int Unload() { return unload(); }

    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);

    public static void StartWatchdog() {
        uint me = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
        Thread t = new Thread(delegate() {
            while (true) {
                EnumWindows(delegate(IntPtr h, IntPtr l) {
                    uint pid; GetWindowThreadProcessId(h, out pid);
                    if (pid == me && IsWindowVisible(h)) {
                        StringBuilder cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
                        if (cls.ToString() == "#32770") {
                            StringBuilder sb = new StringBuilder();
                            StringBuilder title = new StringBuilder(512); GetWindowTextW(h, title, 512);
                            sb.Append(title.ToString()).Append(": ");
                            EnumChildWindows(h, delegate(IntPtr c, IntPtr l2) {
                                StringBuilder tx = new StringBuilder(4096); GetWindowTextW(c, tx, 4096);
                                if (tx.Length > 0) sb.Append(tx.ToString()).Append(" | ");
                                return true; }, IntPtr.Zero);
                            lock (Dialogs) Dialogs.Add(sb.ToString());
                            PostMessageW(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
                        }
                    }
                    return true; }, IntPtr.Zero);
                Thread.Sleep(200);
            }
        });
        t.IsBackground = true; t.Start();
    }

    public static string TakeDialogs() {
        lock (Dialogs) { string s = String.Join("\n", Dialogs.ToArray()); Dialogs.Clear(); return s; }
    }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
[ShioriHost]::StartWatchdog()
if ($Charset -eq 'UTF-8') { [ShioriHost]::Enc = New-Object System.Text.UTF8Encoding($false) }
elseif ($Charset -ne 'Shift_JIS') { throw "-Charset: Shift_JIS or UTF-8" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$sw = New-Object System.IO.StreamWriter($Out, $false, $utf8)
$sw.AutoFlush = $true
$t0 = Get-Date
$ok = [ShioriHost]::Load($GhostDir, $Dll)
$sw.WriteLine("### load=$ok ({0:N1}s)" -f ((Get-Date) - $t0).TotalSeconds)
$d = [ShioriHost]::TakeDialogs(); if ($d) { $sw.WriteLine("### DIALOG at load: $d") }

$lines = [System.IO.File]::ReadAllLines($Requests, $utf8)
foreach ($line in $lines) {
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $parts = $line.Split("`t")
    $id = $parts[0]; $method = 'GET'
    if ($id.StartsWith('!')) { $method = 'NOTIFY'; $id = $id.Substring(1) }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("$method SHIORI/3.0`r`nCharset: $Charset`r`nSender: SSP`r`nSecurityLevel: local`r`nID: $id`r`n")
    for ($i = 1; $i -lt $parts.Length; $i++) { [void]$sb.Append("Reference$($i-1): $($parts[$i])`r`n") }
    [void]$sb.Append("`r`n")
    $res = [ShioriHost]::Request($sb.ToString())
    $val = ''
    if ($res) {
        foreach ($rl in $res.Split("`n")) { if ($rl.StartsWith('Value: ')) { $val = $rl.Substring(7).TrimEnd("`r") } }
        $status = $res.Split("`n")[0].TrimEnd("`r")
    } else { $status = '(null)' }
    $sw.WriteLine("=== $line")
    $sw.WriteLine("STATUS $status")
    if ($val) { $sw.WriteLine("VALUE $val") }
    $d = [ShioriHost]::TakeDialogs(); if ($d) { $sw.WriteLine("DIALOG $d") }
}
[void][ShioriHost]::Unload()
$d = [ShioriHost]::TakeDialogs(); if ($d) { $sw.WriteLine("### DIALOG at unload: $d") }
$sw.WriteLine("### done ({0:N1}s)" -f ((Get-Date) - $t0).TotalSeconds)
$sw.Close()
