$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  [Console]::Out.WriteLine('{"error":"constrained-language"}'); [Console]::Out.Flush(); exit 3
}
# UTF-8 without a BOM: the console default is the OEM code page, which turns
# a non-ASCII app name or title into '?' before Node ever sees it.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TytForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$titles = __TITLES__
$parentId = __PARENT__
$names = @{}
$last = ''
$lastLine = [DateTime]::UtcNow
$lastParentCheck = [DateTime]::UtcNow
while ($true) {
  $line = '{"none":true}'
  $window = [TytForeground]::GetForegroundWindow()
  if ($window -ne [IntPtr]::Zero) {
    $processId = [uint32]0
    [void][TytForeground]::GetWindowThreadProcessId($window, [ref]$processId)
    $path = ''
    $handle = [TytForeground]::OpenProcess(0x1000, $false, $processId)
    if ($handle -ne [IntPtr]::Zero) {
      $buffer = New-Object System.Text.StringBuilder 1024
      $size = [uint32]1024
      if ([TytForeground]::QueryFullProcessImageNameW($handle, 0, $buffer, [ref]$size)) { $path = $buffer.ToString() }
      [void][TytForeground]::CloseHandle($handle)
    }
    if ($path -ne '') {
      $exe = [System.IO.Path]::GetFileName($path)
      if (-not $names.ContainsKey($path)) {
        $description = ''
        try { $description = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileDescription } catch { }
        if ([string]::IsNullOrWhiteSpace($description)) { $description = $exe }
        $names[$path] = $description
      }
      $record = [ordered]@{ key = $exe; name = $names[$path]; pid = [int]$processId }
      if ($titles) {
        $text = New-Object System.Text.StringBuilder 512
        [void][TytForeground]::GetWindowTextW($window, $text, 512)
        $record.title = $text.ToString()
      }
      $line = ConvertTo-Json -InputObject $record -Compress
    }
  }
  $now = [DateTime]::UtcNow
  if ($line -ne $last) {
    [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line; $lastLine = $now
  } elseif (($now - $lastLine).TotalSeconds -ge 30) {
    [Console]::Out.WriteLine('{"alive":true}'); [Console]::Out.Flush(); $lastLine = $now
  }
  if (($now - $lastParentCheck).TotalSeconds -ge 30) {
    $lastParentCheck = $now
    if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { exit 0 }
  }
  Start-Sleep -Seconds 1
}
