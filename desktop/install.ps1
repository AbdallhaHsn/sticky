# Run once on the employee's PC (or double-click install.bat).
# Verifies the login against the server, saves it, copies agent files to %APPDATA%\StickyAgent,
# registers autostart, and starts the agent.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Join-Path $env:APPDATA 'StickyAgent'
$fontsDir = Join-Path $dir 'fonts'
New-Item -ItemType Directory -Force $dir | Out-Null
New-Item -ItemType Directory -Force $fontsDir | Out-Null

$ok = $false
while (-not $ok) {
  $server = (Read-Host 'Server address [press Enter for https://sticky.abdallaswe.tech]').Trim()
  if (-not $server) { $server = 'https://sticky.abdallaswe.tech' }
  $server = $server.TrimEnd('/')
  $user = (Read-Host 'Username').Trim()
  $pass = Read-Host 'Password' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass))
  try {
    $body = [Text.Encoding]::UTF8.GetBytes((@{ username = $user; password = $plain } | ConvertTo-Json))
    $r = Invoke-RestMethod -Uri "$server/api/login" -Method POST -Body $body -ContentType 'application/json; charset=utf-8' -UseBasicParsing
    Write-Host "Login OK: $($r.user.name) ($($r.user.role))" -ForegroundColor Green
    $ok = $true
  } catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($status -eq 401) { Write-Host 'Wrong username or password. Try again.' -ForegroundColor Red }
    else { Write-Host "Cannot reach the server at $server ($($_.Exception.Message)). Check the address and that the server is running." -ForegroundColor Red }
  }
}

@{ server = $server; username = $user; token = $r.token; password = ($pass | ConvertFrom-SecureString) } |
  ConvertTo-Json | Set-Content (Join-Path $dir 'config.json') -Encoding UTF8

# Copy agent.ps1 and fonts into %APPDATA%\StickyAgent so no project folder is needed on the user's PC
$srcAgent = Join-Path $PSScriptRoot 'agent.ps1'
$dstAgent = Join-Path $dir 'agent.ps1'
if ((Test-Path $srcAgent) -and ($srcAgent -ne $dstAgent)) {
  Copy-Item $srcAgent $dstAgent -Force
  if (Test-Path (Join-Path $PSScriptRoot 'fonts')) {
    Copy-Item (Join-Path $PSScriptRoot 'fonts\*') $fontsDir -Force
  }
}

$cmd = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dstAgent`""
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'StickyNotesAgent.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = 'powershell.exe'; $s.Arguments = $cmd; $s.WorkingDirectory = $dir; $s.WindowStyle = 7; $s.Save()

# stop any agent already running so the new login takes effect
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*agent.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Process powershell.exe -ArgumentList $cmd
Write-Host 'Done. The agent runs at every Windows startup and shows your assigned notes on the desktop.'
