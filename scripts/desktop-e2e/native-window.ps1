param(
  [Parameter(Mandatory=$true)][int]$LauncherPid,
  [Parameter(Mandatory=$true)][int]$DebugPort,
  [Parameter(Mandatory=$true)][string]$ExpectedTitle,
  [ValidateSet('inspect','minimize','close','restore')][string]$Action = 'inspect',
  [long]$WindowHandle = 0
)
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process)
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($LauncherPid)
do {
  $added = $false
  foreach ($process in $processes) {
    if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $added = $true }
  }
} while ($added)
$targets = @($processes | Where-Object {
  $owned.Contains([int]$_.ProcessId) -and $_.Name -eq 'electron.exe' -and $_.CommandLine.Contains("--remote-debugging-port=$DebugPort") -and $_.CommandLine -notmatch '(?:^|\s)--type='
})
if ($targets.Count -ne 1) { throw "Expected exactly one main Electron process owned by this launcher and debugging port; found $($targets.Count)" }
$targetProcessId = [uint32]$targets[0].ProcessId
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PioraTestWindow {
  public delegate bool EnumCallback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static string Title(IntPtr h) { var text=new StringBuilder(2048);GetWindowText(h,text,text.Capacity);return text.ToString(); }
  public static long[] Find(uint process, string title) {
    var windows=new List<long>();
    EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==process && Title(h)==title)windows.Add(h.ToInt64());return true;},IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
if ($WindowHandle -eq 0) {
  $windows = @([PioraTestWindow]::Find($targetProcessId, $ExpectedTitle))
  if ($windows.Count -ne 1) { throw 'Expected exactly one native Piora window in the owned test process' }
  $WindowHandle = $windows[0]
}
$nativeWindow = [IntPtr]::new($WindowHandle)
$actualOwner = [uint32]0
[void][PioraTestWindow]::GetWindowThreadProcessId($nativeWindow, [ref]$actualOwner)
if ($actualOwner -ne $targetProcessId) { throw 'Window ownership changed; refusing native operation' }
switch ($Action) {
  'minimize' { if (-not [PioraTestWindow]::PostMessage($nativeWindow, 0x0112, [IntPtr]::new(0xF020), [IntPtr]::Zero)) { throw 'Minimize command failed' } }
  'close' { if (-not [PioraTestWindow]::PostMessage($nativeWindow, 0x0112, [IntPtr]::new(0xF060), [IntPtr]::Zero)) { throw 'Close command failed' } }
  'restore' { if (-not [PioraTestWindow]::PostMessage($nativeWindow, 0x0112, [IntPtr]::new(0xF120), [IntPtr]::Zero)) { throw 'Restore command failed' }; [void][PioraTestWindow]::SetForegroundWindow($nativeWindow) }
}
@{ handle=$WindowHandle; processId=$targetProcessId; title=[PioraTestWindow]::Title($nativeWindow); visible=[PioraTestWindow]::IsWindowVisible($nativeWindow); minimized=[PioraTestWindow]::IsIconic($nativeWindow); action=$Action } | ConvertTo-Json -Compress
