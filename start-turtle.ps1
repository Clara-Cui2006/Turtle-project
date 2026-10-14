$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appUrl = 'http://127.0.0.1:5173'
$healthUrl = "$appUrl/api/health"
$dataRoot = Join-Path $env:APPDATA 'TurtleProject'
$logRoot = Join-Path $dataRoot 'logs'

function Test-TurtleService {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    return $health.status -eq 'ok'
  } catch {
    return $false
  }
}

Set-Location $projectRoot

if (-not (Test-TurtleService)) {
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Turtle build failed.' }

  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $stdout = Join-Path $logRoot 'app.log'
  $stderr = Join-Path $logRoot 'app-error.log'
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $npmCli = Join-Path (Split-Path $npm) 'node_modules\npm\bin\npm-cli.js'
  $env:PORT = '5173'
  Start-Process -FilePath $node -ArgumentList @("`"$npmCli`"",'run','start') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-TurtleService) { $ready = $true; break }
  }
  if (-not $ready) { throw "Turtle failed to start. See: $stderr" }
}

Start-Process $appUrl
