# Loaded only after guest-tests.ps1 verifies the payload and owned VM identity.
$cancelMachine = Get-CimInstance Win32_ComputerSystem
if ($cancelMachine.Manufacturer -ne 'SAHM-QA-VM' -or $cancelMachine.Model -ne 'SAHM-QA-QEMU' -or $env:USERNAME -ne 'SAHMTest' -or !(Test-Path -LiteralPath 'C:\SahmLab\owned-vm.txt')) { throw 'Dedicated standard-user VM required.' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SahmCancelUi {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
}
'@
function Find-UiButton($window, [string]$id) {
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}
function Start-TestSetup([string]$setup, [string]$arguments = '') {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $setup; $info.Arguments = $arguments; $info.WorkingDirectory = $lab
  $info.UseShellExecute = $false; $info.CreateNoWindow = $false
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  [void]$process.Start()
  return $process
}
function Installer-Windows {
  $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
  return @($windows | Where-Object { $_.Current.Name -match 'SAHM|سَهم|سهم' })
}
function Click-UiButton($button) {
  Require ($button -and $button.Current.IsEnabled) 'Expected enabled installer button.'
  Require ($button.Current.NativeWindowHandle -ne 0) 'Installer button has no native handle.'
  # BM_CLICK is posted asynchronously so the confirmation dialog cannot block the test thread.
  Require ([SahmCancelUi]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) 'Could not post installer button click.'
}
function Cancellation-Snapshot {
  $paths = @($runtime, (Join-Path $installation 'resources\app.asar'))
  foreach ($name in @('jobs.json','preferences.json','credentials.dat','quota.json','queues.json','Local State')) { $paths += Join-Path $profile $name }
  if (Test-Path -LiteralPath (Join-Path $lab 'expected.json')) {
    $fixture = Get-Content -LiteralPath (Join-Path $lab 'expected.json') -Raw -Encoding utf8 | ConvertFrom-Json
    $paths += @($fixture.complete.path, $fixture.post.path, ($fixture.partial.path + '.part'), ($fixture.partial.path + '.resume.json'))
  }
  $files = @($paths | Select-Object -Unique | ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Leaf) { [ordered]@{ path = $_; hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash } } })
  $keys = @()
  foreach ($browser in @('Google\Chrome','Microsoft\Edge')) {
    $key = 'HKCU:\Software\' + $browser + '\NativeMessagingHosts\com.sahm.downloader'
    $keys += [ordered]@{ key = $key; value = $(if (Test-Path -LiteralPath $key) { (Get-Item -LiteralPath $key).GetValue('') } else { $null }) }
  }
  $run = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  $uninstallRecords = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -match 'SAHM' } | Sort-Object PSChildName | ForEach-Object { [ordered]@{ key = $_.PSChildName; version = $_.DisplayVersion; command = $_.UninstallString } })
  return [ordered]@{ files = $files; integration = $keys; startup = $run.'com.sahm.downloadmanager'; runtimeExists = (Test-Path -LiteralPath $runtime); shortcuts = @(Shortcuts); uninstallRecords = $uninstallRecords }
}
function Test-InstallerCancellation($entry, [string]$label, $runningApp = $null) {
  Emit 'cancel-preflight' @{ label = $label }
  $setup = Join-Path $Media $entry.file
  Require ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.sha256) 'Cancellation installer hash mismatch.'
  Emit 'cancel-snapshot-start' @{ label = $label }
  $before = Cancellation-Snapshot
  Emit 'cancel-start' @{ label = $label; installerSha256 = $entry.sha256 }
  $setupProcess = Start-TestSetup $setup
  $deadline = (Get-Date).AddSeconds(120); $wizard = $null; $cancel = $null
  do {
    foreach ($window in Installer-Windows) {
      if ($window.Current.Name -like 'SAHM*Language') {
        $languageOk = Find-UiButton $window '1'
        if ($languageOk -and $languageOk.Current.IsEnabled) {
          Click-UiButton $languageOk
          Emit 'installer-language-confirmed' @{ label = $label; title = $window.Current.Name }
          Start-Sleep -Milliseconds 500
        }
        continue
      }
      $candidate = Find-UiButton $window '2'
      if ($candidate -and $candidate.Current.IsEnabled) { $wizard = $window; $cancel = $candidate; break }
    }
    if ($cancel) { break }; Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  Require ($cancel) 'Interactive installer did not expose its Cancel button.'
  Emit 'cancel-wizard-ready' @{ label = $label; title = $wizard.Current.Name; buttonName = $cancel.Current.Name; buttonEnabled = $cancel.Current.IsEnabled; beforeFileWrites = $true }
  Click-UiButton $cancel
  $confirmed = $false; $deadline = (Get-Date).AddSeconds(30)
  do {
    foreach ($window in Installer-Windows) {
      $yes = Find-UiButton $window '6'
      if ($yes -and $yes.Current.IsEnabled) { Click-UiButton $yes; $confirmed = $true; break }
    }
    if ($confirmed -or $setupProcess.HasExited) { break }; Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  Require ($setupProcess.WaitForExit(60000)) 'Cancelled installer remained running.'
  Require ($setupProcess.ExitCode -eq 1) ('Expected NSIS user cancellation exit 1, got ' + $setupProcess.ExitCode)
  Start-Sleep -Milliseconds 500
  $after = Cancellation-Snapshot
  Require (($before | ConvertTo-Json -Depth 8 -Compress) -eq ($after | ConvertTo-Json -Depth 8 -Compress)) 'Cancellation changed application, profile, files or integration.'
  if ($runningApp) { $runningApp.Refresh(); Require (!$runningApp.HasExited) 'Cancelling before installation stopped the running old app.' }
  $result = @{ label = $label; ok = $true; exitCode = $setupProcess.ExitCode; confirmationShown = $confirmed; existingFilesUnchanged = $true; integrationUnchanged = $true; previousAppKeptRunning = [bool]$runningApp; cancellationPhase = 'wizard-before-file-writes' }
  Emit 'cancel-result' $result
  $setupProcess.Dispose()
  return $result
}

function Test-InterruptedFreshInstall($entry) {
  Require (!(Test-Path -LiteralPath $runtime) -and !(Test-Path -LiteralPath $profile)) 'Fresh interruption test requires no installed app or profile.'
  $setup = Join-Path $Media $entry.file
  Require ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.sha256) 'Interruption installer hash mismatch.'
  $process = Start-TestSetup $setup '/S'
  $owned = @($process.Id); $observed = @(); $deadline = (Get-Date).AddSeconds(120)
  do {
    $children = @(Get-CimInstance Win32_Process | Where-Object { $owned -contains $_.ParentProcessId })
    $owned = @(@($owned) + @($children | ForEach-Object { $_.ProcessId }) | Select-Object -Unique)
    if (Test-Path -LiteralPath $installation) { $observed = @(Get-ChildItem -LiteralPath $installation -File -Recurse -ErrorAction SilentlyContinue) }
    if ($observed.Count -gt 0) { break }
    Require (!$process.HasExited) 'Installer finished before extraction could be interrupted.'
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  Require ($observed.Count -gt 0) 'No extracted files observed before interruption.'
  Require (!$process.HasExited) 'Installer already exited before interruption.'
  foreach ($id in @($owned | Sort-Object -Descending)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  Require ($process.WaitForExit(30000)) 'Interrupted installer did not stop.'
  $process.Dispose()
  Start-Sleep -Seconds 1
  Require (!(Test-Path -LiteralPath $profile)) 'Interrupted setup touched the application profile.'
  $result = @{ interruptionObserved = $true; phase = 'fresh-file-extraction'; filesObserved = $observed.Count; ownedProcessesStopped = $owned.Count; profileUntouched = $true; reinstalled = $false }
  Emit 'installation-interrupted' $result
  return $result
}
