; Instalador da "Central do Recepcionista".
;
; Instala o app.exe (Flask, 127.0.0.1:8000) + o launcher que o mantem sempre
; a correr em segundo plano, arranca-o no inicio de sessao de todos os
; utilizadores e publica a extensao do Chrome via politica de maquina.
;
; Compilar com:
;   installer\build_installer.ps1
; ou directamente:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\CentralRecepcionista.iss

#define MyAppName "Central do Recepcionista"
#define MyAppPublisher "Uso interno"
#define MyAppExeName "Central_Recepcionist_conf_plus_printer.exe"
#define MyAppLauncher "CentralRecepcionistaLauncher.exe"
#define MyAppUrl "http://127.0.0.1:8000/"
#define ChromePolicyKey "SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"

; ExtId, ExtVersion, ExtUpdateUrl, ExtCrxFile
#include "generated\build_vars.iss"

[Setup]
AppId={{8B3D2A64-5E71-4F0C-9D2B-7A1C6E4F2B90}
AppName={#MyAppName}
AppVersion={#ExtVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={commonappdata}\CentralRecepcionista
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist
OutputBaseFilename=CentralRecepcionista_Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppLauncher}
SetupLogging=yes
AllowNoIcons=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "portuguese"; MessagesFile: "compiler:Languages\Portuguese.isl"

[Tasks]
Name: "startup"; Description: "Arrancar automaticamente com o Windows (recomendado)"; GroupDescription: "Arranque:"
Name: "desktopicon"; Description: "Criar atalho no ambiente de trabalho"; GroupDescription: "Atalhos:"; Flags: unchecked

[Dirs]
; O app.py grava conferencia.json ao lado do executavel, por isso a pasta
; tem de ser gravavel por todos os utilizadores.
Name: "{app}"; Permissions: users-modify
Name: "{app}\logs"; Permissions: users-modify
Name: "{app}\crx"; Permissions: users-modify
Name: "{app}\extension"; Permissions: users-modify

[Files]
Source: "..\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "generated\{#MyAppLauncher}"; DestDir: "{app}"; Flags: ignoreversion
; Extensao por instalar a mao ("Carregar sem compactacao") — mesmo ID do CRX
; gracas ao campo "key" injetado no manifest.json.
Source: "generated\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
; CRX + manifesto de atualizacao, servidos pelo launcher em 127.0.0.1:8011
Source: "generated\{#ExtCrxFile}"; DestDir: "{app}\crx"; Flags: ignoreversion
Source: "generated\updates.xml"; DestDir: "{app}\crx"; Flags: ignoreversion
Source: "generated\extension_id.txt"; DestDir: "{app}\crx"; Flags: ignoreversion
Source: "LEIA-ME.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{commonstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"; Tasks: startup
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"
Name: "{group}\Abrir no navegador"; Filename: "{#MyAppUrl}"
Name: "{group}\Instalar a extensao no Chrome (manual)"; Filename: "{app}\{#MyAppLauncher}"; Parameters: "--chrome-extension-help"
Name: "{group}\Pasta de instalacao"; Filename: "{app}"
Name: "{group}\Desinstalar {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Instalacao silenciosa da extensao em todas as contas do Chrome da maquina.
; O Chrome vai buscar updates.xml ao launcher local, que serve o CRX assinado.
Root: HKLM64; Subkey: "{#ChromePolicyKey}"; ValueType: string; ValueName: "1"; ValueData: "{#ExtId};{#ExtUpdateUrl}"; Flags: uninsdeletevalue
Root: HKLM32; Subkey: "{#ChromePolicyKey}"; ValueType: string; ValueName: "1"; ValueData: "{#ExtId};{#ExtUpdateUrl}"; Flags: uninsdeletevalue

[Run]
; Sempre (inclusive em /VERYSILENT): volta a pôr o launcher de pé depois de
; substituir os ficheiros, para o app não ficar em baixo até ao próximo logon.
Filename: "{app}\{#MyAppLauncher}"; Flags: nowait runhidden
; Opcional, só no assistente
Filename: "{app}\{#MyAppLauncher}"; Parameters: "--chrome-extension-help"; Description: "Abrir o Chrome para confirmar/instalar a extensao"; Flags: postinstall nowait skipifsilent unchecked

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\extension"
Type: filesandordirs; Name: "{app}\crx"
Type: files; Name: "{app}\conferencia.json"

[Code]
const
  ChromePolicy = 'SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist';

function ChromeExecutable(): String;
var
  Candidates: array[0..2] of String;
  I: Integer;
begin
  Candidates[0] := ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe');
  Candidates[1] := ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe');
  Candidates[2] := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  Result := '';
  for I := 0 to 2 do
    if FileExists(Candidates[I]) then
    begin
      Result := Candidates[I];
      Exit;
    end;
end;

procedure StopRunningCentral();
var
  Launcher: String;
  ResultCode: Integer;
begin
  Launcher := ExpandConstant('{app}\{#MyAppLauncher}');
  if FileExists(Launcher) then
    Exec(Launcher, '--stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningCentral();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopRunningCentral();
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if (not WizardSilent) and (ChromeExecutable() <> '') then
      MsgBox('A extensao foi registada na politica do Chrome.' + #13#10 + #13#10 +
             'Feche e volte a abrir o Chrome para a instalacao automatica entrar em vigor.' + #13#10 +
             'Se o Chrome recusar a instalacao automatica, use o atalho' + #13#10 +
             '"Instalar a extensao no Chrome (manual)" no menu Iniciar.',
             mbInformation, MB_OK);
end;
