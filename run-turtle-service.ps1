$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataRoot = Join-Path $env:APPDATA 'TurtleProject'
$logRoot = Join-Path $dataRoot 'logs'
$stdout = Join-Path $logRoot 'app.log'
$stderr = Join-Path $logRoot 'app-error.log'
$node = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
Set-Location $projectRoot
$env:PORT = '5173'

while ($true) {
  & $node 'apps\server\dist\index.js' 1>> $stdout 2>> $stderr
  "[$(Get-Date -Format o)] Service exited; restarting in 5 seconds." | Add-Content -LiteralPath $stderr -Encoding utf8
  Start-Sleep -Seconds 5
}
