# Compilar e distribuir a Central do Recepcionista

Este documento é para quem **mantém** o projeto. Para quem apenas instala a
Central numa máquina de recepção, o guia é o
[`installer/LEIA-ME.txt`](installer/LEIA-ME.txt), que é copiado para dentro da
pasta de instalação.

---

## Comando único

```powershell
.\installer\build_installer.ps1
```

Corre a partir da raiz do projeto. Produz **um único ficheiro** para distribuir:

```
installer\dist\CentralRecepcionista_Setup.exe
```

Esse ficheiro traz tudo dentro (aplicação, launcher, extensão e CRX), por isso
é o único que precisa de ser copiado para as outras máquinas.

---

## Antes de compilar: subir a versão

Se alterou **a extensão** (qualquer ficheiro em
`CRM-LIKE_conference/desbravador-conferencia`), suba o campo `version` em
`CRM-LIKE_conference/desbravador-conferencia/manifest.json` **antes** de compilar.

O Chrome descarta uma atualização cuja versão não seja superior à instalada. Se
publicar ficheiros diferentes com a mesma versão, todas as máquinas já
instaladas **ignoram a alteração em silêncio**. Por isso o build recusa:

```
[ext] ERRO: a extensão mudou mas continua na versão 2.1.3.
      Suba "version" em CRM-LIKE_conference/desbravador-conferencia/manifest.json
```

Essa mesma versão é a que aparece em Programas e Funcionalidades e no nome da
extensão, ou seja, é a versão da **release** inteira.

Não é preciso subir a versão se apenas mexeu em `app.py`, no
`installer/launcher.py` ou no `.iss`.

---

## Opções

| Comando | Para quê |
|---|---|
| `.\installer\build_installer.ps1` | Rebuild completo (aplicação + extensão + launcher + instalador) |
| `... -SkipApp` | Só extensão/launcher/instalador, reaproveitando o `app.exe` existente (muito mais rápido) |
| `... -SkipCrossCheck` | Não valida o CRX contra o Chrome (mais rápido, menos seguro) |
| `... -AllowSameVersion` | Publica extensão alterada sem subir a versão (evitar) |

---

## O que o script faz

| Passo | Resultado |
|---|---|
| 1. Ambientes Python | `.venv` (dependências da aplicação) e `installer\.venv-build` (ferramentas de build) |
| 2. `app.exe` | `dist\Central_Recepcionist_conf_plus_printer.exe` (~41 MB) |
| 3. Extensão | `central_recepcao.crx` + `updates.xml` em `installer\generated\` |
| 4. Launcher | `installer\generated\CentralRecepcionistaLauncher.exe` |
| 5. Inno Setup | `installer\dist\CentralRecepcionista_Setup.exe` (~50 MB) |

O passo 3 é a rede de segurança: o CRX é empacotado pelo código do projeto **e**
pelo próprio Chrome (`--pack-extension`), assinatura conferida e ID comparado.
Se não bater, o build falha em vez de emitir um CRX inválido.

### Dois ambientes Python, de propósito

`cryptography` e `pyinstaller` (ferramentas de build) vivem em
`installer\.venv-build`, fora do `.venv`. Assim nada do build acaba empacotado
dentro do `app.exe` — já aconteceu de o PyInstaller arrastar o `cryptography`
para dentro do executável, acrescentando ~4 MB de peso inútil.

---

## Distribuir

Copie o `Setup.exe` e execute (precisa de administrador):

```powershell
# instalação silenciosa, para várias máquinas
CentralRecepcionista_Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

A instalação vai para `C:\ProgramData\CentralRecepcionista` e:

* cria o atalho de arranque para todos os utilizadores;
* registra a política do Chrome (`ExtensionInstallForcelist`);
* arranca o launcher.

**Reinicie o Chrome** depois de instalar: a política só é lida no arranque.

### Atualizar uma máquina que já tem a versão antiga

Basta correr o `Setup.exe` novo. O mesmo `AppId` faz com que o Inno Setup
substitua **no lugar**:

1. Antes de copiar seja o que for, chama `CentralRecepcionistaLauncher.exe --stop`,
   que mata o launcher e a aplicação (mesmo um `app.exe` aberto à mão) e espera
   que feche.
2. Substitui os ficheiros. `conferencia.json` e `logs\` são **preservados**.
3. Volta a arrancar o launcher — inclusive em modo silencioso.

Inatividade de poucos segundos.

---

## Desinstalar

```powershell
"C:\ProgramData\CentralRecepcionista\unins000.exe" /VERYSILENT
```

Remove ficheiros, atalho de arranque e a política do Chrome. Uma extensão
carregada **à mão** tem de ser removida em `chrome://extensions`.

---

## Não fazer

* **Não apague nem regenere a chave** `installer\keys\central_recepcao.pem`.
  É ela que define o ID da extensão (`anllminopjfbhojkjhcecjfeflojeiji`) usado
  na política do Chrome e no campo `key` do manifest. Se se perder, todas as
  máquinas passam a ter uma **segunda** extensão em vez de uma atualização.
  A chave é reaproveitada automaticamente, por isso não é preciso mexer nela.
* **Não compile numa máquina de destino** — distribua o `Setup.exe`.
* **Não use `-AllowSameVersion`** numa release que vai para máquinas que já têm
  a extensão instalada.

---

## Resolução de problemas

| Sintoma | Causa / solução |
|---|---|
| `Inno Setup 6 nao encontrado` | `winget install JRSoftware.InnoSetup` |
| `[ext] ERRO: ... continua na versão` | Suba `version` no manifest (ver acima) |
| `Falha a compilar app.py` | Erro real do PyInstaller — ver o traceback acima no output |
| `[cross-check] FALHOU` | O build recusa emitir um CRX não verificado; ler a mensagem |
| Instalador compila mas a extensão não aparece | Esperado em versões recentes do Chrome (bloqueia extensões fora da Web Store). Usar o atalho **"Instalar a extensao no Chrome (manual)"** |

### Nota sobre o output

O script imprime um bloco `NativeCommandError` perto do início (o PyInstaller
escreve avisos no stderr). **É cosmético.** Confie no código de saída e na
mensagem `=== Pronto ===`.

---

## Estrutura do projeto

```
app.py                            aplicação Flask (127.0.0.1:8000)
requirements.txt                  dependências da aplicação
conferencia.json                  dados da conferência (gerado em execução)
templates/, static/, tools/       recursos da aplicação (SumatraPDF para impressão)
Central_Recepcionist_conf_plus_printer.spec    receita PyInstaller do app.exe
dist/                             app.exe gerado

CRM-LIKE_conference/
  desbravador-conferencia/        EXTENSÃO do Chrome (fonte)
    manifest.json                 ← subir "version" aqui a cada alteração
    content.js                    mapa de UHs, barra lateral, filtro de check-out
    central.js                    Central de Impressões como tela nativa
    main-world.js                 ponte para o contexto da página
    background.js                 sessão, proxy /api/*
    content.css                   estilos injetados

installer/                        tudo o que é build/distribuição
  build_installer.ps1             ← o comando a correr
  build_extension.py              chave estável, CRX3, updates.xml
  launcher.py                     supervisor + servidor do CRX
  CentralRecepcionista.iss        instalador (Inno Setup)
  requirements-build.txt          ferramentas de build (ambiente separado)
  LEIA-ME.txt                     guia do utilizador final (vai para a instalação)
  keys/central_recepcao.pem       NÃO APAGAR (define o ID da extensão)
  generated/                      CRX, updates.xml, launcher, extensão pronta
  dist/                           Setup.exe gerado
```

---

## Recuperar algo apagado

Tudo o que foi removido estava versionado no git:

```powershell
git checkout -- <caminho>      # repõe um ficheiro
git status                     # ver o que foi removido
```
