# Run once on the employee's PC (or double-click install.bat).
# Verifies the login against the server, saves it (password protected with Windows DPAPI for this user),
# registers autostart, and starts the agent.
$dir = Join-Path $env:APPDATA 'StickyAgent'
New-Item -ItemType Directory -Force $dir | Out-Null

$ok = $false
while (-not $ok) {
  $server = (Read-Host 'Server address (e.g. http://192.168.1.10:3000)').Trim()
  if (-not $server) { $server = 'http://localhost:3000' }
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

@{ server = $server; username = $user; password = ($pass | ConvertFrom-SecureString) } |
  ConvertTo-Json | Set-Content (Join-Path $dir 'config.json') -Encoding UTF8

$agent = Join-Path $PSScriptRoot 'agent.ps1'
$cmd = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agent`""
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'StickyNotesAgent.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = 'powershell.exe'; $s.Arguments = $cmd; $s.WorkingDirectory = $PSScriptRoot; $s.WindowStyle = 7; $s.Save()

# stop any agent already running so the new login takes effect
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*-File*agent.ps1*' -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Process powershell.exe -ArgumentList $cmd
Write-Host 'Done. The agent runs at every Windows startup and shows your assigned notes on the desktop.'
