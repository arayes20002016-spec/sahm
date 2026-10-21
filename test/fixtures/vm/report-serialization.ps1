param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Source)
$ErrorActionPreference = 'Stop'
$nativeProcessLog = Join-Path $Directory 'synthetic-native.log'
[IO.File]::WriteAllLines($nativeProcessLog, [string[]](1..300 | ForEach-Object { 'synthetic-check ' + $_ }), [Text.Encoding]::UTF8)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Guest test source has syntax errors.' }
$assignment = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$report.nativeProcessControl' }, $true)
if (!$assignment) { throw 'Diagnostic log reader is missing.' }
$report = @{ ok = $false; error = 'Synthetic failure for diagnostic regression' }
# Exercise the real reader without invoking the VM-only test runner.
Invoke-Expression $assignment.Extent.Text
$json = $report | ConvertTo-Json -Depth 16 -Compress
$parsed = $json | ConvertFrom-Json
if (@($parsed.nativeProcessControl).Count -ne 200) { throw 'Diagnostic tail was not bounded.' }
if (@($parsed.nativeProcessControl | Where-Object { $_ -isnot [string] }).Count) { throw 'Filesystem provider metadata leaked into JSON.' }
@{ powerShellMajor = $PSVersionTable.PSVersion.Major; lines = @($parsed.nativeProcessControl).Count; plainStrings = $true; jsonBytes = [Text.Encoding]::UTF8.GetByteCount($json) } | ConvertTo-Json -Compress
