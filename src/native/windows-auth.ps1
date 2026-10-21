$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$contexts = @{}

function Reply($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 5))
  [Console]::Out.Flush()
}

try {
  $bootstrapLine = [Console]::In.ReadLine()
  if (!$bootstrapLine -or $bootstrapLine.Length -gt 524288) { throw 'Invalid bootstrap' }
  $bootstrap = ConvertFrom-Json -InputObject $bootstrapLine
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($bootstrap.source))
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  Reply @{ ready = $true }
} catch {
  Reply @{ ready = $false; code = 'helper-compile-failed' }
  exit 1
}

try {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (!$line -or $line.Length -gt 262144) { break }
    $request = $null
    try {
      $request = ConvertFrom-Json -InputObject $line
      $id = $request.id
      switch ($request.op) {
        'create' {
          if ($contexts.Count -ge 32 -or $contexts.ContainsKey($request.context)) { throw 'Too many contexts' }
          $context = [SahmWindowsAuth.ClientContext]::new($request.scheme, $request.host, [bool]$request.currentAccount, $request.username, $request.password, $request.domain, $request.channelBinding)
          $contexts[$request.context] = $context
          Reply @{ id = $id; ok = $true }
        }
        'step' {
          if (!$contexts.ContainsKey($request.context)) { throw 'Unknown context' }
          $result = $contexts[$request.context].Step($request.token)
          Reply @{ id = $id; ok = $true; token = $result.Token; complete = $result.Complete; package = $result.Package; attributes = $result.Attributes }
        }
        'close' {
          if ($contexts.ContainsKey($request.context)) { $contexts[$request.context].Dispose(); $contexts.Remove($request.context) }
          Reply @{ id = $id; ok = $true }
        }
        'exit' { Reply @{ id = $id; ok = $true }; exit 0 }
        default { throw 'Unknown operation' }
      }
    } catch {
      $status = $null
      $exception = $_.Exception
      while ($exception) {
        if ($exception -is [SahmWindowsAuth.SspiException]) { $status = '{0:x8}' -f $exception.Status; break }
        $exception = $exception.InnerException
      }
      Reply @{ id = $request.id; ok = $false; code = 'windows-authentication-failed'; status = $status }
    }
  }
} finally {
  foreach ($context in @($contexts.Values)) { $context.Dispose() }
  $contexts.Clear()
}
