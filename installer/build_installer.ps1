<#
.SYNOPSIS
    Compila tudo o que o instalador da Central do Recepcionista precisa.

.DESCRIPTION
    Um comando para atualizar tudo. Mude o que precisar (app.py, a extensao em
    CRM-LIKE_conference\desbravador-conferencia, installer\launcher.py) e corra:

        .\installer\build_installer.ps1

    O script:
      1. garante o .venv e as dependencias de build;
      2. reconstroi dist\Central_Recepcionist_conf_plus_printer.exe (app.py);
      3. re-empacota a extensao do Chrome (chave estavel, CRX3, updates.xml);
      4. reconstroi CentralRecepcionistaLauncher.exe;
      5. gera installer\dist\CentralRecepcionista_Setup.exe.

    O Setup.exe e o UNICO ficheiro a distribuir -- traz tudo dentro.

    Dois ambientes, de proposito:
      .venv                  dependencias da aplicacao (requirements.txt).
                             E daqui que sai o app.exe.
      installer\.venv-build  ferramentas de build (cryptography, pyinstaller).
                             Fica separado para que nada do build acabe
                             empacotado dentro do app.exe.

    ANTES DE COMPILAR: se alterou a extensao, suba o campo "version" em
    CRM-LIKE_conference\desbravador-conferencia\manifest.json. O Chrome so
    aceita uma atualizacao cuja versao seja superior; o script recusa
    publicar extensao alterada com a mesma versao. (E essa mesma versao que
    aparece em Programas e Funcionalidades.)

.EXAMPLE
    .\installer\build_installer.ps1

.EXAMPLE
    .\installer\build_installer.ps1 -SkipApp -SkipCrossCheck
    Iteracao rapida sobre a extensao, reaproveitando o app.exe existente.
#>
[CmdletBinding()]
param(
    [switch] $SkipApp,
    [switch] $SkipCrossCheck,
    [switch] $AllowSameVersion
)

$ErrorActionPreference = "Stop"

$installerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $installerDir
$appPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
$buildPython = Join-Path $installerDir ".venv-build\Scripts\python.exe"
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

# ---------------------------------------------------------------- 1. ambientes
Write-Step "Ambientes Python"

if (-not (Test-Path $appPython)) {
    Write-Host "A criar .venv (aplicacao)..."
    python -m venv (Join-Path $projectRoot ".venv")
}
& $appPython -m pip install --disable-pip-version-check -q -r (Join-Path $projectRoot "requirements.txt")
if (-not $?) { throw "Falha a instalar requirements.txt no .venv" }

if (-not (Test-Path $buildPython)) {
    Write-Host "A criar installer\.venv-build (ferramentas de build)..."
    python -m venv (Join-Path $installerDir ".venv-build")
}
& $buildPython -m pip install --disable-pip-version-check -q -r (Join-Path $installerDir "requirements-build.txt")
if (-not $?) { throw "Falha a instalar requirements-build.txt" }

# ------------------------------------------------------------------- 2. app.exe
Write-Step "Aplicacao (app.exe)"
if ($SkipApp -and (Test-Path $appExe)) {
    Write-Host "A reutilizar $appExe (-SkipApp)"
}
else {
    Write-Host "A compilar $appExeName com PyInstaller..."
    & $appPython -m PyInstaller --noconfirm --clean (Join-Path $projectRoot "Central_Recepcionist_conf_plus_printer.spec")
    if (-not $?) { throw "Falha a compilar app.py" }
}
if (-not (Test-Path $appExe)) { throw "$appExe nao existe" }

# ------------------------------------------------------------------ 3. extensao
Write-Step "Extensao do Chrome (CRX3)"
$extArgs = @((Join-Path $installerDir "build_extension.py"))
if (-not $SkipCrossCheck) { $extArgs += "--cross-check-chrome" }
if ($AllowSameVersion) { $extArgs += "--allow-same-version" }
& $buildPython @extArgs
if (-not $?) { throw "Falha a preparar a extensao" }

# ------------------------------------------------------------------- 4. launcher
Write-Step "Launcher"
New-Item -ItemType Directory -Force -Path $generated, $buildDir | Out-Null
& $buildPython -m PyInstaller `
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
Write-Host "app.exe    : $([math]::Round((Get-Item $appExe).Length / 1MB, 1)) MB"
Write-Host "Extensao   : $((Get-Content (Join-Path $generated 'extension_id.txt')).Trim())"
