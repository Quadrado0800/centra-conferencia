$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPath = Join-Path $projectRoot ".venv"
$pythonPath = Join-Path $venvPath "Scripts\python.exe"

Set-Location $projectRoot

if (-not (Test-Path $pythonPath)) {
    Write-Host "Creating virtual environment..."
    python -m venv $venvPath
}

Write-Host "Installing dependencies..."
& $pythonPath -m pip install --upgrade pip
& $pythonPath -m pip install -r (Join-Path $projectRoot "requirements.txt")

Write-Host "Building dist\central_conferencia.exe..."
& $pythonPath -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --name central_conferencia `
    --add-data "templates;templates" `
    --add-data "static;static" `
    --add-data "tools;tools" `
    --collect-submodules win32com `
    app.py

Write-Host "Build complete: $(Join-Path $projectRoot 'dist\central_conferencia.exe')"