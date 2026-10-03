<#
.SYNOPSIS
    Compila tudo o que o instalador da Central do Recepcionista precisa.

.DESCRIPTION
    1. Garante o .venv e as dependencias de build.
    2. Garante dist\Central_Recepcionist_conf_plus_printer.exe (-RebuildApp
       para forcar a reconstrucao via PyInstaller).
    3. Prepara a extensao do Chrome: chave estavel, CRX3, updates.xml.
    4. Compila o launcher (CentralRecepcionistaLauncher.exe).
    5. Compila o instalador com o Inno Setup.

.EXAMPLE
    .\installer\build_installer.ps1
    .\installer\build_installer.ps1 -RebuildApp -SkipCrossCheck
#>
[CmdletBinding()]
param(
    [switch] $RebuildApp,
    [switch] $SkipCrossCheck
)

$ErrorActionPreference = "Stop"

$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $installerDir
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$appExeName = "Central_Recepcionist_conf_plus_printer.exe"
$appExe = Join-Path $projectRoot "dist\$appExeName"
$generated = Join-Path $installerDir "generated"
$buildDir = Join-Path $installerDir "build"

function Write-Step([string] $text) {
    Write-Host ""
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Get-IsccPath {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw "Inno Setup 6 nao encontrado. Instale com: winget install JRSoftware.InnoSetup"
}

Set-Location $projectRoot

# ---------------------------------------------------------------- 1. ambiente
Write-Step "Ambiente Python"
if (-not (Test-Path $python)) {
    Write-Host "A criar .venv..."
    python -m venv (Join-Path $projectRoot ".venv")
}
if (-not $?) { throw "Falha ao criar o .venv" }

& $python -m pip install --disable-pip-version-check -q -r (Join-Path $installerDir "requirements-build.txt")
if (-not $?) { throw "Falha a instalar as dependencias de build" }

# ------------------------------------------------------------------- 2. app.exe
Write-Step "Aplicacao (app.exe)"
if ($RebuildApp -or -not (Test-Path $appExe)) {
    Write-Host "A compilar $appExeName com PyInstaller..."
    & $python -m PyInstaller --noconfirm --clean (Join-Path $projectRoot "Central_Recepcionist_conf_plus_printer.spec")
    if (-not $?) { throw "Falha a compilar app.py" }
}
else {
    Write-Host "A reutilizar $appExe"
}
if (-not (Test-Path $appExe)) { throw "$appExe nao existe" }

# ------------------------------------------------------------------ 3. extensao
Write-Step "Extensao do Chrome (CRX3)"
$extArgs = @((Join-Path $installerDir "build_extension.py"))
if (-not $SkipCrossCheck) { $extArgs += "--cross-check-chrome" }
& $python @extArgs
if (-not $?) { throw "Falha a preparar a extensao" }

# ------------------------------------------------------------------- 4. launcher
Write-Step "Launcher"
New-Item -ItemType Directory -Force -Path $generated, $buildDir | Out-Null
& $python -m PyInstaller `
    --noconfirm --clean --onefile --noconsole `
    --name "CentralRecepcionistaLauncher" `
    --distpath $generated `
    --workpath (Join-Path $buildDir "pyinstaller") `
    --specpath $buildDir `
    (Join-Path $installerDir "launcher.py")
if (-not $?) { throw "Falha a compilar o launcher" }

$launcherExe = Join-Path $generated "CentralRecepcionistaLauncher.exe"
if (-not (Test-Path $launcherExe)) { throw "$launcherExe nao existe" }

# ---------------------------------------------------------------- 5. instalador
Write-Step "Instalador (Inno Setup)"
$iscc = Get-IsccPath
& $iscc (Join-Path $installerDir "CentralRecepcionista.iss")
if (-not $?) { throw "Falha a compilar o instalador" }

$setup = Join-Path $installerDir "dist\CentralRecepcionista_Setup.exe"
Write-Step "Pronto"
Write-Host "Instalador : $setup"
Write-Host "Extensao   : $((Get-Content (Join-Path $generated 'extension_id.txt')).Trim())"
