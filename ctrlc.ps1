param([int]$ProcId)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class C {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint grp);
}
"@
[C]::FreeConsole() | Out-Null
if (-not [C]::AttachConsole($ProcId)) { exit 2 }
[C]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
[C]::GenerateConsoleCtrlEvent(1, 0) | Out-Null
Start-Sleep -Milliseconds 500
