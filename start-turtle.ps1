param(
  [switch]$NoBrowser,
  [switch]$SkipBuild
)

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
  if (-not $SkipBuild) {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Turtle build failed.' }
  }
  if (-not (Test-Path (Join-Path $projectRoot 'apps\server\dist\index.js')) -or -not (Test-Path (Join-Path $projectRoot 'apps\web\dist\index.html'))) {
    throw 'Turtle build files are missing. Run start-turtle.cmd once.'
  }

  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $stderr = Join-Path $logRoot 'app-error.log'
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $runner = Join-Path $projectRoot 'run-turtle-service.ps1'
  Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$runner`"") -WorkingDirectory $projectRoot -WindowStyle Hidden

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-TurtleService) { $ready = $true; break }
  }
  if (-not $ready) { throw "Turtle failed to start. See: $stderr" }
}

if (-not $NoBrowser) { Start-Process $appUrl }
