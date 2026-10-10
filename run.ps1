$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Push-Location "$root\backend"
uv sync
$api = Start-Process -PassThru -NoNewWindow uv -ArgumentList "run", "python", "main.py"
Pop-Location

Push-Location "$root\frontend"
if (-not (Test-Path node_modules)) { npm install }
Write-Host "API: http://127.0.0.1:8000   UI: http://localhost:5173"
try { npm run dev }
finally {
    Pop-Location
    if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force }
}
