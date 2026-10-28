# Drawbook installer for Windows 10/11. No npm needed. In PowerShell:
#
#   irm https://raw.githubusercontent.com/Vlad-Beresnev/drawbook/main/install.ps1 | iex
#
# It installs into %LOCALAPPDATA%\Drawbook\app-home: a private Node.js runtime,
# the app, and opencode 2 (for the AI Drawer) unless an opencode 2 is already
# installed. Then it starts Drawbook in the background at every logon and
# opens it. Your drawings live in %USERPROFILE%\Drawings and are never touched.
# Run it again to update. To remove the app:
#
#   $env:DRAWBOOK_UNINSTALL = "1"; irm https://raw.githubusercontent.com/Vlad-Beresnev/drawbook/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is very slow with the progress bar

$Repo = "Vlad-Beresnev/drawbook"
$NodeVersion = "22.23.0"     # tested with Drawbook
$OpencodeVersion = "2.0.32"  # tested with Drawbook; opencode 1 does not work

$HomeDir = if ($env:DRAWBOOK_HOME) { $env:DRAWBOOK_HOME } else { Join-Path $env:LOCALAPPDATA "Drawbook\app-home" }
$Port = if ($env:DRAWBOOK_PORT) { $env:DRAWBOOK_PORT } else { "4747" }
$AppUrl = if ($env:DRAWBOOK_APP_URL) { $env:DRAWBOOK_APP_URL } else { "https://github.com/$Repo/releases/latest/download/drawbook.zip" }
$TaskName = if ($env:DRAWBOOK_SERVICE_NAME) { $env:DRAWBOOK_SERVICE_NAME } else { "Drawbook" }
$Url = "http://127.0.0.1:$Port"

function Say($text) { Write-Host $text -ForegroundColor Cyan }

function Stop-Drawbook {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # The task's node.exe (and its opencode child) can outlive the task.
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($HomeDir) -and $_.Name -in @("node.exe", "opencode.exe") } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Get-Version($exe) {
  try { $out = & $exe --version 2>$null | Select-Object -First 1 } catch { return "" }
  if ("$out" -match "(\d+\.\d+\.\d+)") { return $Matches[1] }
  return ""
}

if ($env:DRAWBOOK_UNINSTALL -eq "1") {
  Stop-Drawbook
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $HomeDir -ErrorAction SilentlyContinue
  Remove-Item Env:DRAWBOOK_UNINSTALL
  Say "Drawbook is removed. Your drawings are still in $HOME\Drawings."
  return
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("drawbook-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp, $HomeDir | Out-Null

try {
  # 1. Node.js runtime, private to Drawbook (your own Node, if any, is not touched).
  $node = Join-Path $HomeDir "node\node.exe"
  if ((Get-Version $node) -ne $NodeVersion) {
    Say "Downloading Node.js $NodeVersion..."
    $name = "node-v$NodeVersion-win-$arch"
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$name.zip" -OutFile "$tmp\node.zip"
    Expand-Archive "$tmp\node.zip" -DestinationPath $tmp
    Stop-Drawbook
    Remove-Item -Recurse -Force (Join-Path $HomeDir "node") -ErrorAction SilentlyContinue
    Move-Item "$tmp\$name" (Join-Path $HomeDir "node")
  }

  # 2. The app (already built: no npm install).
  Say "Downloading Drawbook..."
  Invoke-WebRequest $AppUrl -OutFile "$tmp\drawbook.zip"
  Expand-Archive "$tmp\drawbook.zip" -DestinationPath "$tmp\app"
  if (-not (Test-Path "$tmp\app\drawbook\server\index.js")) { throw "The download is not a Drawbook release." }
  Stop-Drawbook
  Remove-Item -Recurse -Force (Join-Path $HomeDir "app") -ErrorAction SilentlyContinue
  Move-Item "$tmp\app\drawbook" (Join-Path $HomeDir "app")

  # 3. opencode 2 for the AI Drawer. An opencode 2 .exe you already have is used as is.
  $opencode = $null
  $found = Get-Command opencode -ErrorAction SilentlyContinue
  if ($found -and $found.Source -like "*.exe" -and (Get-Version $found.Source) -like "2.*") {
    $opencode = $found.Source
    Say "Using your opencode $(Get-Version $opencode)."
  } else {
    $opencode = Join-Path $HomeDir "opencode\opencode.exe"
    if ((Get-Version $opencode) -ne $OpencodeVersion) {
      Say "Downloading opencode $OpencodeVersion..."
      $target = "windows-$arch"
      Invoke-WebRequest "https://registry.npmjs.org/@opencode/cli-$target/-/cli-$target-$OpencodeVersion.tgz" -OutFile "$tmp\opencode.tgz"
      tar -xzf "$tmp\opencode.tgz" -C $tmp # tar.exe is part of Windows 10 and 11
      New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir "opencode") | Out-Null
      Move-Item -Force "$tmp\package\bin\opencode.exe" $opencode
    }
  }

  # 4. Start in the background now and at every logon. A Scheduled Task cannot
  #    set environment variables, so Node reads them from a file (--env-file).
  #    conhost --headless keeps the console window hidden.
  $envFile = Join-Path $HomeDir "drawbook.env"
  Set-Content -Encoding ascii -Path $envFile -Value @("DRAWBOOK_PORT=$Port", "OPENCODE_BIN=$opencode")
  $server = Join-Path $HomeDir "app\server\index.js"
  $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$node`" --env-file=`"$envFile`" `"$server`"" -WorkingDirectory (Join-Path $HomeDir "app")
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Drawbook (local Excalidraw app)" -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  $ok = $false
  for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
    try { Invoke-WebRequest "$Url/api/drawings" -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ok) { throw "Drawbook did not start. Try: & `"$node`" --env-file=`"$envFile`" `"$server`"" }

  Say "Drawbook is running at $Url"
  Write-Host "  Drawings: $HOME\Drawings"
  Write-Host "  Make it an app: open $Url in Chrome or Edge, then ... -> Apps -> Install this site as an app."
  Write-Host "  Use your ChatGPT plan in the AI Drawer: & `"$opencode`" auth login openai"
  if (-not $env:DRAWBOOK_NO_OPEN) { Start-Process $Url }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
