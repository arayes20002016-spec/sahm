param([Parameter(Mandatory)]$Serial, [Parameter(Mandatory)][string]$Media)
$ErrorActionPreference = 'Stop'
$machine = Get-CimInstance Win32_ComputerSystem
if ($machine.Manufacturer -ne 'SAHM-QA-VM' -or $machine.Model -ne 'SAHM-QA-QEMU' -or $env:USERNAME -ne 'SAHMTest' -or !(Test-Path -LiteralPath 'C:\SahmLab\owned-vm.txt')) { throw 'Dedicated standard-user VM required.' }
$lab = 'C:\SahmLab'
$installation = Join-Path $env:LOCALAPPDATA 'Programs\SAHM'
$runtime = Join-Path $installation 'SAHM.exe'
$profile = Join-Path $env:APPDATA 'sahm-download-manager'
$toolsMedia = @([IO.Directory]::GetLogicalDrives() | Where-Object { Test-Path -LiteralPath ($_ + 'SAHMTOOLS.TAG') })[0]
if (!$toolsMedia) { throw 'Read-only test runtime media missing.' }
$report = @{ ok = $false; operatingSystem = (Get-CimInstance Win32_OperatingSystem).Caption; standardUser = $true; realNsisExecuted = $true; stages = @(); cancellations = @() }
function Emit($kind, $data) { $Serial.WriteLine('SAHM_VM_EVENT ' + (@{ event = $kind; data = $data; utc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 16 -Compress)) }
function Require($condition, $message) { if (!$condition) { throw $message } }
function Run-Program([string]$exe, [string[]]$arguments, [string]$label, [int]$seconds = 300) {
  Emit 'process-start' @{ label = $label; timeoutSeconds = $seconds }
  $out = Join-Path $lab ($label + '.stdout.txt'); $err = Join-Path $lab ($label + '.stderr.txt')
  $start = @{ FilePath = $exe; WorkingDirectory = $lab; WindowStyle = 'Hidden'; PassThru = $true; RedirectStandardOutput = $out; RedirectStandardError = $err }
  if ($arguments.Count) { $start.ArgumentList = $arguments }
  $process = Start-Process @start
  try {
    # Retain the native handle so Windows PowerShell 5.1 preserves ExitCode.
    $ownedHandle = $process.Handle
    $watch = [Diagnostics.Stopwatch]::StartNew(); $nextProgress = 30
    while (!$process.HasExited) {
      if ($watch.Elapsed.TotalSeconds -ge $seconds) { $process.Kill(); throw ('Timed out: ' + $label) }
      if ($watch.Elapsed.TotalSeconds -ge $nextProgress) {
        Emit 'process-progress' @{ label = $label; elapsedSeconds = [int]$watch.Elapsed.TotalSeconds; runtimeExists = (Test-Path -LiteralPath $runtime); archiveExists = (Test-Path -LiteralPath (Join-Path $installation 'resources\app.asar')) }
        $nextProgress += 30
      }
      Start-Sleep -Milliseconds 250
      $process.Refresh()
    }
    $code = $process.ExitCode
  } finally { $process.Dispose() }
  Require ($code -eq 0) ($label + ' failed with exit ' + $code + ': ' + (Get-Content -LiteralPath $err -Raw -Encoding utf8 -ErrorAction SilentlyContinue))
  Emit 'process-exit' @{ label = $label; exitCode = $code }
}
function Version {
  $value = [Diagnostics.FileVersionInfo]::GetVersionInfo($runtime).ProductVersion
  Require ($value -match '^\d+\.\d+\.\d+$') 'Installed executable has no semantic product version.'
  Emit 'version-metadata' @{ version = $value; executable = $runtime }
  return $value
}
function Shortcuts {
  # Read an ASCII copy through in-process WScript.Shell, avoiding Explorer RPC.
  $shortcutShell = New-Object -ComObject WScript.Shell
  $ownedShortcuts = @()
  $probes = Join-Path $lab 'shortcut-probes'
  [void][IO.Directory]::CreateDirectory($probes)
  $index = 0
  foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue) {
      $probe = Join-Path $probes ('probe-' + $index + '.lnk')
      $index++
      Copy-Item -LiteralPath $file.FullName -Destination $probe -Force
      $link = $shortcutShell.CreateShortcut($probe)
      if ($link.TargetPath -eq $runtime) { $ownedShortcuts += $file.FullName }
    }
  }
  return $ownedShortcuts
}
function Uninstall-Records {
  # NSIS writes InstallLocation to its separate installation metadata key.
  return @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.UninstallString -eq $script:uninstallCommand })
}
function Install($entry, $label) {
  $setup = Join-Path $Media $entry.file
  Require ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -eq $entry.sha256) 'Installer hash mismatch.'
  $installSeconds = 300
  if ($configuration.installTimeoutSeconds) { $installSeconds = [int]$configuration.installTimeoutSeconds; Require ($installSeconds -ge 300 -and $installSeconds -le 900) 'Invalid VM install deadline.' }
  Run-Program $setup @('/S') $label $installSeconds
  Require (Test-Path -LiteralPath $runtime) 'Installed executable missing.'
  Require ((Version) -eq $entry.version) 'Wrong version after NSIS installation.'
  if ($entry.version -eq $configuration.candidate.version -and $configuration.expectedAppAsarSha256) {
    Emit 'installed-hash-start' @{ file = 'resources/app.asar' }
    Require ((Get-FileHash -LiteralPath (Join-Path $installation 'resources\app.asar') -Algorithm SHA256).Hash.ToLowerInvariant() -eq $configuration.expectedAppAsarSha256) 'Installed application archive differs from candidate.'
    Emit 'installed-hash-start' @{ file = 'SAHM.exe' }
    Require ((Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant() -eq $configuration.expectedExecutableSha256) 'Installed executable differs from candidate.'
  }
  Emit 'installed-identity-verified' @{ version = $entry.version }
  $script:installedVersion = $entry.version
  Emit 'shortcuts-start' @{ label = $label }
  $script:installedShortcuts = @(Shortcuts)
  Require ($script:installedShortcuts.Count -ge 2) 'Desktop or Start Menu shortcut missing.'
  Emit 'shortcuts-verified' @{ paths = $script:installedShortcuts; target = $runtime }
  $uninstallers = @(Get-ChildItem -LiteralPath $installation -Filter 'Uninstall*.exe')
  Require ($uninstallers.Count -eq 1) 'Expected one installed uninstaller.'
  $script:uninstallCommand = '"' + $uninstallers[0].FullName + '" /currentuser'
  $records = @(Uninstall-Records)
  Require ($records.Count -eq 1 -and $records[0].DisplayVersion -eq $entry.version) 'Per-user uninstallation record is missing or stale.'
  if ($script:foreignProcess) { $script:foreignProcess.Refresh(); Require (!$script:foreignProcess.HasExited) 'Installer stopped a same-named process in another directory.' }
}
function Fixture($phase, $label) {
  $env:SAHM_VM_INSTALLED_RUNTIME = $runtime
  try { Run-Program (Join-Path $toolsMedia 'electron\electron.exe') @(('"' + (Join-Path $Media 'profile-fixture.cjs') + '"'), $phase, ('"--user-data-dir=' + $profile + '"')) $label }
  finally { Remove-Item Env:\SAHM_VM_INSTALLED_RUNTIME -ErrorAction SilentlyContinue }
}
function Export-Screenshot([string]$file, [string]$label) {
  $bytes = [IO.File]::ReadAllBytes($file)
  Require ($bytes.Length -gt 0 -and $bytes.Length -le 1048576) 'Unexpected screenshot size.'
  $base64 = [Convert]::ToBase64String($bytes)
  Emit 'artifact-start' @{ name = ($label + '.png'); bytes = $bytes.Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
  # Small writes stay below COM1's per-write deadline, including at 115200 baud.
  for ($offset = 0; $offset -lt $base64.Length; $offset += 4096) {
    $chunkLength = [Math]::Min(4096, $base64.Length - $offset)
    Emit 'artifact-chunk' @{ name = ($label + '.png'); index = [int]($offset / 4096); content = $base64.Substring($offset, $chunkLength) }
  }
  Emit 'artifact-end' @{ name = ($label + '.png') }
}
function Start-Application($label) {
  $env:SAHM_SCREENSHOT = Join-Path $lab ($label + '.png')
  try { Run-Program -exe $runtime -arguments @() -label ($label + '-capture') }
  finally { Remove-Item Env:\SAHM_SCREENSHOT -ErrorAction SilentlyContinue }
  $screenshot = Join-Path $lab ($label + '.png')
  Require (Test-Path -LiteralPath $screenshot) 'Installed application did not produce a UI capture.'
  if ($configuration.exportScreenshots -and $label -ne 'previous-app') { Export-Screenshot $screenshot $label }
  $diagnostics = Join-Path $lab ($label + '-live.log')
  $env:SAHM_DIAGNOSTICS = $diagnostics
  try { $process = Start-Process -FilePath $runtime -ArgumentList '--background' -PassThru -WindowStyle Hidden }
  finally { Remove-Item Env:\SAHM_DIAGNOSTICS -ErrorAction SilentlyContinue }
  $end = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $end) {
    Start-Sleep -Milliseconds 500; $process.Refresh(); Require (!$process.HasExited) 'Application exited before readiness.'
    if ((Test-Path -LiteralPath $diagnostics) -and (Get-Content -LiteralPath $diagnostics -Raw -Encoding utf8).Contains('window loaded')) { break }
  }
  Require (Test-Path -LiteralPath (Join-Path $lab ($label + '.png'))) 'Installed application did not reach its UI.'
  Require ((Get-Content -LiteralPath $diagnostics -Raw -Encoding utf8).Contains('window loaded')) 'Background application did not become ready.'
  if ([version]$script:installedVersion -ge [version]'0.15.0') {
    Require ((Get-Content -LiteralPath $diagnostics -Raw -Encoding utf8).Contains('credential vault available: true')) 'Installed application could not unlock its credential vault.'
  }
  $startupValue = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').'com.sahm.downloadmanager'
  Require (@(('"' + $runtime + '" --background'), ($runtime + ' --background')) -contains $startupValue) 'Startup registration did not target installed runtime.'
  return $process
}
function Stop-Application {
  $owned = @(Get-CimInstance Win32_Process -Filter "name='SAHM.exe'" | Where-Object { $_.ExecutablePath -eq $runtime })
  foreach ($process in $owned) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 700
}
function Uninstall($label, [bool]$expectClean) {
  $before = Get-Content -LiteralPath (Join-Path $lab 'expected.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $downloadPaths = @($before.complete.path, $before.post.path) + @(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($before.partial.path)) -File | ForEach-Object { $_.FullName })
  $downloadHashes = @($downloadPaths | Select-Object -Unique | ForEach-Object { @{ path = $_; hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash } })
  $vaultHash = (Get-FileHash -LiteralPath (Join-Path $profile 'credentials.dat')).Hash
  $uninstaller = @(Get-ChildItem -LiteralPath $installation -Filter 'Uninstall*.exe')[0].FullName
  Run-Program $uninstaller @('/S') $label
  $end = (Get-Date).AddSeconds(180)
  do {
    $remainingShortcuts = @($script:installedShortcuts | Where-Object { Test-Path -LiteralPath $_ })
    $remainingRecords = @(Uninstall-Records)
    if (!(Test-Path -LiteralPath $runtime) -and $remainingShortcuts.Count -eq 0 -and $remainingRecords.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $end)
  Require (!(Test-Path -LiteralPath $runtime)) 'Executable remained after uninstallation.'
  foreach ($shortcut in $script:installedShortcuts) {
    Require (!(Test-Path -LiteralPath $shortcut)) ('Uninstaller retained a dead shortcut: ' + $shortcut)
  }
  Require (@(Uninstall-Records).Count -eq 0) 'Uninstaller retained its uninstall record.'
  Require (@(Get-CimInstance Win32_Process -Filter "name='SAHM.exe'" | Where-Object { $_.ExecutablePath -eq $runtime }).Count -eq 0) 'Application remained running after uninstallation.'
  Require ((Get-FileHash -LiteralPath $before.complete.path).Hash.ToLowerInvariant() -eq $before.completedHash) 'Uninstaller changed completed file.'
  foreach ($file in $downloadHashes) { Require ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash -eq $file.hash) ('Uninstaller changed download data: ' + $file.path) }
  Require ((Get-FileHash -LiteralPath (Join-Path $profile 'credentials.dat')).Hash -eq $vaultHash) 'Uninstaller changed encrypted credential vault.'
  Require (Test-Path -LiteralPath (Join-Path $profile 'jobs.json')) 'Uninstaller deleted download history.'
  Fixture 'preserved' ($label + '-credentials')
  $leftovers = @()
  foreach ($browser in @('Google\Chrome','Microsoft\Edge')) {
    $key = 'HKCU:\Software\' + $browser + '\NativeMessagingHosts\com.sahm.downloader'
    if (Test-Path -LiteralPath $key) { $leftovers += $key }
  }
  foreach ($value in @('com.sahm.downloadmanager','SAHM')) {
    if ((Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').PSObject.Properties.Name -contains $value) { $leftovers += ('HKCU Run ' + $value) }
  }
  $result = @{ label = $label; filesAndProfileRetained = $true; downloadFilesRetained = $downloadHashes.Count; backgroundStopped = $true; registrationLeftovers = $leftovers; integrationClean = ($leftovers.Count -eq 0) }
  Emit 'uninstall-result' $result
  if ($expectClean) { Require ($leftovers.Count -eq 0) ('Stale integration: ' + ($leftovers -join ', ')) }
  else {
    # Only clean this synthetic guest's known integration after recording baseline behavior.
    foreach ($browser in @('Google\Chrome','Microsoft\Edge')) {
      $key = 'HKCU:\Software\' + $browser + '\NativeMessagingHosts\com.sahm.downloader'
      if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key }
    }
    foreach ($value in @('com.sahm.downloadmanager','SAHM')) { Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $value -ErrorAction SilentlyContinue }
  }
  if ($script:foreignProcess) { $script:foreignProcess.Refresh(); Require (!$script:foreignProcess.HasExited) 'Uninstaller stopped a same-named process in another directory.'; $report.foreignProcessUnaffected = $true }
  return $result
}
function Archive-Profile($label) {
  if ($configuration.archivePrefix) { Require ($configuration.archivePrefix -match '^[a-z0-9-]+$') 'Invalid archive prefix.'; $label = $configuration.archivePrefix + '-' + $label }
  $destination = [IO.Path]::GetFullPath((Join-Path $lab ('archive-' + $label)))
  Require ($destination.StartsWith('C:\SahmLab\archive-')) 'Unexpected fixture archive path.'
  Require ([IO.Path]::GetFullPath($profile) -eq (Join-Path $env:APPDATA 'sahm-download-manager')) 'Unexpected synthetic profile path.'
  Move-Item -LiteralPath $profile -Destination $destination
}
function Start-ForeignProcess {
  if ($script:foreignProcess) { return }
  $folder = Join-Path $lab 'foreign-process-fixture'
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  $file = Join-Path $folder 'SAHM.exe'
  if (!(Test-Path -LiteralPath $file)) {
    Add-Type -TypeDefinition 'public static class SahmForeignFixture { public static void Main() { System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); } }' -OutputAssembly $file -OutputType ConsoleApplication
  }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $file; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $script:foreignProcess = New-Object Diagnostics.Process
  $script:foreignProcess.StartInfo = $info
  [void]$script:foreignProcess.Start()
  Emit 'foreign-process-started' @{ path = $file; id = $script:foreignProcess.Id }
}
function Test-FreshCycle {
  if ($configuration.runCancellation) {
    $report.cancellations += Test-InstallerCancellation $configuration.candidate 'cancel-fresh'
    $report.installationRecovery = Test-InterruptedFreshInstall $configuration.candidate
  }
  Install $configuration.candidate 'fresh-install'
  if ($report.installationRecovery) { $report.installationRecovery.reinstalled = $true; Emit 'installation-recovered' $report.installationRecovery }
  Fixture 'seed' 'fresh-seed'
  $app = Start-Application 'fresh-app'
  $report.stages += Uninstall 'fresh-uninstall' $configuration.expectClean
}
function Test-UpgradeCycle([bool]$existing) {
  if (!$existing) { Install $configuration.previous 'install-previous'; Fixture 'seed' 'previous-seed' }
  else {
    Require (Test-Path -LiteralPath (Join-Path $lab 'expected.json')) 'Previous fixture metadata missing.'
    if (!(Test-Path -LiteralPath $runtime)) { Install $configuration.previous 'restore-previous-for-upgrade' }
    $script:installedVersion = Version
    Require ($script:installedVersion -eq $configuration.previous.version) 'Resume requires the exact previous version still installed.'
  }
  $app = Start-Application 'previous-app'
  if ($configuration.runCancellation) { $report.cancellations += Test-InstallerCancellation $configuration.candidate 'cancel-upgrade' $app }
  Install $configuration.candidate 'upgrade-installer'
  $app.Refresh(); Require ($app.HasExited) 'Upgrade did not close previous running application.'
  Stop-Application
  Fixture 'verify' 'upgrade-verify'
  $report.upgrade = Get-Content -LiteralPath (Join-Path $lab 'verified.json') -Raw -Encoding utf8 | ConvertFrom-Json
  if ($configuration.checkForeignProcess) { Start-ForeignProcess }
  $app = Start-Application 'upgraded-app'
  $report.stages += Uninstall 'upgraded-uninstall' $configuration.expectClean
}
$resultWriter = $null
$seedConfiguration = Get-Content -LiteralPath (Join-Path $Media 'test-phase.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($seedConfiguration.resultTransport -eq 'disk') {
  $expectedGeneration = (Get-Content -LiteralPath (Join-Path $Media 'SAHMCHK.JSON') -Raw -Encoding utf8 | ConvertFrom-Json).generation
  $resultDrives = @([IO.Directory]::GetLogicalDrives() | Where-Object {
    $tag = Join-Path $_ 'SAHMRES.TAG'
    (Test-Path -LiteralPath $tag) -and (Get-Content -LiteralPath $tag -Raw -Encoding utf8).Trim() -eq $expectedGeneration
  })
  Require ($resultDrives.Count -eq 1) 'Exactly one owned result disk is required.'
  $resultWriter = New-Object PSObject -Property @{ Path = (Join-Path $resultDrives[0] 'EVENTS.LOG'); Encoding = (New-Object Text.UTF8Encoding($false)) }
  $resultWriter | Add-Member -MemberType ScriptMethod -Name WriteLine -Value {
    param([string]$message)
    $bytes = $this.Encoding.GetBytes($message + [Environment]::NewLine)
    $stream = [IO.File]::Open($this.Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    try { [void]$stream.Seek(0, [IO.SeekOrigin]::End); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
  }
  $Serial = $resultWriter
  Emit 'result-transport' @{ type = 'private-fat-result-disk'; generation = $expectedGeneration; sharedHostFilesystem = $false }
}
$server = $null
try {
  $mediaCheck = Get-Content -LiteralPath (Join-Path $Media 'SAHMCHK.JSON') -Raw -Encoding utf8 | ConvertFrom-Json
  Require ($mediaCheck.v -eq 1 -and $mediaCheck.generation -match '^[a-f0-9]{16}$') 'Invalid media manifest.'
  Require (@($mediaCheck.files).Count -gt 0 -and @($mediaCheck.files).Count -le 30) 'Unexpected media inventory.'
  foreach ($file in $mediaCheck.files) {
    Require ($file.name -match '^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$') 'Unexpected media filename.'
    $target = Join-Path $Media $file.name
    Require ((Get-Item -LiteralPath $target).Length -eq $file.bytes) ('Stale media length: ' + $file.name)
    Require ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $file.sha256) ('Media hash mismatch: ' + $file.name)
  }
  Emit 'media-verified' @{ generation = $mediaCheck.generation; files = @($mediaCheck.files).Count }
  $report.mediaGeneration = $mediaCheck.generation
  $report.mediaFilesChecked = @($mediaCheck.files).Count
  Require ((Get-Content -LiteralPath (Join-Path $Media 'SAHMVM.TAG') -Raw).Trim() -eq 'SAHM-QA-OWNED-VM') 'Unexpected VM media ownership marker.'
  'SAHM-QA-OWNED-VM' | Set-Content -LiteralPath (Join-Path $lab 'owned-vm.txt') -Encoding ascii
  $configuration = Get-Content -LiteralPath (Join-Path $Media 'test-phase.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $report.installers = @{ previous = $configuration.previous; candidate = $configuration.candidate; expectClean = $configuration.expectClean; runCancellation = [bool]$configuration.runCancellation }
  if ($configuration.runCancellation) { . (Join-Path $Media 'guest-cancel.ps1') }
  $server = Start-Process -FilePath (Join-Path $toolsMedia 'node.exe') -ArgumentList ('"' + (Join-Path $Media 'fixture-server.cjs') + '"') -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if ($configuration.resetCurrentInstallation) {
    Require (Test-Path -LiteralPath $runtime) 'Reset requires the previous disposable test installation.'
    Require ((Get-FileHash -LiteralPath (Join-Path $installation 'resources\app.asar') -Algorithm SHA256).Hash.ToLowerInvariant() -eq $configuration.expectedAppAsarSha256) 'Unexpected installation in disposable test guest.'
    $resetUninstallers = @(Get-ChildItem -LiteralPath $installation -Filter 'Uninstall*.exe')
    Require ($resetUninstallers.Count -eq 1) 'Expected one disposable guest uninstaller.'
    Run-Program $resetUninstallers[0].FullName @('/S') 'reset-test-installation' 300
    $resetDeadline = (Get-Date).AddSeconds(180)
    while ((Test-Path -LiteralPath $runtime) -and (Get-Date) -lt $resetDeadline) { Start-Sleep -Milliseconds 250 }
    Require (!(Test-Path -LiteralPath $runtime)) 'Disposable installation was not removed.'
    Require (!(Test-Path -LiteralPath $profile)) 'Fresh profile is required before acceptance.'
  }
  if ($configuration.resumePrevious) {
    Test-UpgradeCycle $true
    Archive-Profile 'upgraded'
    Test-FreshCycle
  } else {
    Test-FreshCycle
    Archive-Profile 'fresh'
    Test-UpgradeCycle $false
  }
  $report.ok = $true
} catch { $report.error = $_.Exception.Message; $report.stack = $_.ScriptStackTrace }
finally {
  Emit 'finalize-start' @{ ok = $report.ok; error = $report.error }
  if ($script:foreignProcess) { if (!$script:foreignProcess.HasExited) { $script:foreignProcess.Kill(); [void]$script:foreignProcess.WaitForExit(5000) }; $script:foreignProcess.Dispose() }
  $nativeProcessLog = Join-Path $env:TEMP 'SAHM-process-control.log'
  if (Test-Path -LiteralPath $nativeProcessLog) { $report.nativeProcessControl = @([IO.File]::ReadAllLines($nativeProcessLog, [Text.Encoding]::UTF8) | Select-Object -Last 200) }
  $cleanupResult = Join-Path $env:TEMP 'SAHM-uninstall-last-result.json'
  if (Test-Path -LiteralPath $cleanupResult) {
    try { $report.cleanupDiagnostic = Get-Content -LiteralPath $cleanupResult -Raw -Encoding utf8 | ConvertFrom-Json }
    catch { $report.cleanupDiagnostic = @{ error = 'Unreadable cleanup diagnostic' } }
  }
  if ($server) { if (!$server.HasExited) { $server.Kill(); [void]$server.WaitForExit(5000) }; $server.Dispose() }
  Emit 'fixture-server-stopped' @{ ok = $true }
  Emit 'report-write-start' @{ ok = $report.ok }
  $report | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $lab 'installer-result.json') -Encoding utf8
  Emit 'installer-result' $report
}
