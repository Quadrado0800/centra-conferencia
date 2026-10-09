import ctypes
import os
import sys
import time
from pathlib import Path
from datetime import datetime, timezone
import requests
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename
import subprocess
from win32com.client import Dispatch
import fitz
import re
from html.parser import HTMLParser
import json
import pythoncom
import base64

RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else RESOURCE_DIR
SUMATRA_PATH = RESOURCE_DIR / "tools" / "SumatraPDF.exe"

app=Flask(
    __name__,
    template_folder=str(RESOURCE_DIR / "templates"),
    static_folder=str(RESOURCE_DIR / "static"),
)
BASE_DIR=APP_DIR
DOWNLOADS_DIR=Path.home()/"Downloads"
TEMP_DIR=DOWNLOADS_DIR/"temp"
TEMP_DIR.mkdir(parents=True, exist_ok=True)


@app.after_request
def _aplicar_cors(resp):
    """O app escuta apenas em 127.0.0.1 (uso local). Liberar CORS em todas
    as respostas permite que a extensão do Desbravador (e a própria página)
    fale com a Central sem depender de proxy."""
    resp.headers.setdefault("Access-Control-Allow-Origin", "*")
    resp.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    resp.headers.setdefault("Access-Control-Allow-Headers", "Content-Type")
    return resp


def get_temp_dir():
    return TEMP_DIR

def extrair_totais_relatorio(pdf_path):
    """
    Extrai os totais de UH e PAX de um relatório PDF
    do Desbravador.
    """

    documento = fitz.open(pdf_path)

    try:
        texto = "\n".join(
            pagina.get_text()
            for pagina in documento
        )

        return texto

    finally:
        documento.close()

def extrair_totais_checkin(texto):
    """
    Extrai os totais de UHs e PAX do relatório
    de previsão de Check-in.
    """

    match = re.search(
        r"Total\s+(\d+).*?"
        r"Total\s+(\d+)",
        texto,
        re.DOTALL
    )

    if not match:
        raise RuntimeError(
            "Não foi possível encontrar os totais "
            "de UH e PAX no relatório de Check-in."
        )

    uhs = int(match.group(1))
    pax = int(match.group(2))

    return {
        "uh": uhs,
        "pax": pax
    }

def extrair_totais_checkout(texto):
    """
    Extrai os totais de UHs e PAX do relatório
    de previsão de Check-out.

    O relatório apresenta os totais no final como:
        0
        10
        20
        Totais
        Totais do período 0
        10
        20

    Nesse formato:
        10 = UH
        20 = PAX
    """

    match = re.search(
        r"Totais do período\s+(\d+)\s+(\d+)\s+(\d+)",
        texto,
        re.DOTALL
    )

    if not match:
        raise RuntimeError(
            "Não foi possível encontrar os totais "
            "de UH e PAX no relatório de Check-out."
        )

    uhs = int(match.group(2))
    pax = int(match.group(3))

    return {
        "uh": uhs,
        "pax": pax
    }

def extrair_ocupacao_atual(texto):
    """
    Extrai as UHs ocupadas e o total de PAX
    do relatório de Café/Pensão.
    """

    match_pax = re.search(
        r"Total de PAX\s+(\d+)",
        texto,
        re.IGNORECASE
    )

    match_uh = re.search(
        r"Total de UHs Ocupadas\s+(\d+)",
        texto,
        re.IGNORECASE
    )

    if not match_pax:
        raise RuntimeError(
            "Não foi possível encontrar o Total de PAX "
            "no relatório de Café/Pensão."
        )

    if not match_uh:
        raise RuntimeError(
            "Não foi possível encontrar o Total de UHs "
            "Ocupadas no relatório de Café/Pensão."
        )

    return {
        "uh": int(match_uh.group(1)),
        "pax": int(match_pax.group(1))
    }

# Configure these optional files.
DESKTOP = Path(os.path.join(os.environ["USERPROFILE"], "Desktop"))
FICHA_HOSPEDES_PATH = DESKTOP / "Ficha_Hospedagem.docx"
INFORMATIVOS_PATH = DESKTOP / "Informativos_Hospedagem.docx"
INFORMATIVOS_ALL_UHS_PATH = DESKTOP / "Informativos_All_Uhs"
PRINT_CONFIRMATION=True
PRINT_FICHA_HOSPEDES=False
PRINT_INFORMATIVOS=False
PRINT_HOLD_SECONDS=5


def get_print_settings(overrides=None):
    overrides = overrides or {}
    return {
        "print_confirmation": overrides.get("print_confirmation", PRINT_CONFIRMATION),
        "print_ficha": overrides.get("print_ficha", PRINT_FICHA_HOSPEDES),
        "print_informativos": overrides.get("print_informativos", PRINT_INFORMATIVOS),
    }

BASE_URL="https://desbravadorweb.com.br"
_desbravador_cookies=[]


# ============================================================
# RELATÓRIOS DO DESBRAVADOR
# ============================================================

RELATORIO_CHECKOUT_URL = (
    f"{BASE_URL}/relatorios/"
    "relatorioCheckoutPrevisao/imprimir"
)

RELATORIO_OCUPACAO_URL = (
    f"{BASE_URL}/relatorios/"
    "relatorioUhLiberadaOcupada/imprimir"
)

RELATORIO_CHECKIN_URL = (
    f"{BASE_URL}/relatorios/"
    "relatorioCheckinPrevisao/imprimir"
)

RELATORIO_GOVERNANCA_URL = (
    f"{BASE_URL}/relatorios/"
    "relatorioGovernanca/imprimir"
)

def build_session():
    session=requests.Session()
    for cookie in _desbravador_cookies:
        kwargs={}
        if cookie.get("domain"): kwargs["domain"]=cookie["domain"]
        if cookie.get("path"): kwargs["path"]=cookie["path"]
        session.cookies.set(cookie["name"],cookie["value"],**kwargs)
    return session

def baixar_relatorio(session, url, params, nome_arquivo):
    """
    Baixa um relatório do Desbravador e salva temporariamente como PDF.
    """

    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/pdf,*/*",
        "Referer": BASE_URL,
    }

    response = session.get(
        url,
        params=params,
        headers=headers,
        timeout=60
    )

    response.raise_for_status()

    # Verifica se o Desbravador realmente retornou PDF
    if not response.content.startswith(b"%PDF"):
        raise RuntimeError(
            "O Desbravador não retornou um PDF."
        )

    # Garante que a pasta temporária exista
    temp_dir = get_temp_dir()
    temp_dir.mkdir(parents=True, exist_ok=True)

    path = temp_dir / nome_arquivo

    # Salva o PDF
    path.write_bytes(response.content)

    # Confirma que o arquivo foi realmente criado
    if not path.exists():
        raise RuntimeError(
            f"O PDF não foi criado: {path}"
        )

    print(f"[relatório] PDF salvo em: {path}")
    print(f"[relatório] Tamanho: {path.stat().st_size} bytes")

    return path

def baixar_relatorio_pdf(session, url, params, nome_arquivo):
    """
    Baixa um relatório PDF do Desbravador.
    """

    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/pdf,*/*",
        "Referer": BASE_URL,
    }

    response = session.get(
        url,
        params=params,
        headers=headers,
        timeout=60
    )

    response.raise_for_status()

    if not response.content.startswith(b"%PDF"):
        raise RuntimeError(
            "O Desbravador não retornou um PDF."
        )

    path = get_temp_dir() / nome_arquivo

    path.write_bytes(response.content)

    if not path.exists():
        raise RuntimeError(
            f"PDF não foi criado: {path}"
        )

    return path

def baixar_relatorio_checkin_dia(session):
    """
    Gera o relatório detalhado de previsão de check-in
    para o dia atual.
    """

    data = datetime.now().strftime("%d/%m/%Y")

    params = [
        ("rel", "true"),
        ("tipoRelatorio", "DETALHADO"),
        ("pessoaTitular.id", ""),
        ("pessoaTitular.razaoNome", ""),
        ("dataInicio", data),
        ("dataFim", data),
        ("ordenacao", "RESERVA"),
        ("exibirHospedeClassificacao", "on"),
        ("listarObservacaoDosHospedes", "on"),
        ("listarObservacaoPublicaDaHospedagem", "on"),
    ]

    return baixar_relatorio(
        session,
        RELATORIO_CHECKIN_URL,
        params,
        "relatorio_checkin_dia.pdf"
    )

def imprimir_relatorio_checkin_dia():
    """
    Gera e imprime o relatório de check-in do dia.
    """

    if not _desbravador_cookies:
        raise RuntimeError("Sessão não conectada.")


    session = build_session()
    pdf = None

    try:
        pdf = baixar_relatorio_checkin_dia(session)

        imprimir_pdf(pdf)

        return {
            "ok": True,
            "relatorio": "checkin",
            "data": datetime.now().strftime("%d/%m/%Y")
        }

    finally:
        if pdf and pdf.exists():
            try:
                time.sleep(PRINT_HOLD_SECONDS)
                pdf.unlink()
            except OSError:
                pass

def baixar_relatorio_governanca(session, andares, dias_entre_trocas=2):
    """
    Gera um relatório de Governança para os andares informados.
    """

    data = datetime.now().strftime("%d/%m/%Y")

    params = [
        ("rel", "true"),
        ("dataPesquisa", data),

        ("situacoes", "LIVRE"),
        ("situacoes", "OCUPADA"),
        ("situacoes", "MANUTENCAO"),
        ("situacoes", "LIMPEZA"),

        ("checkinPrevisto", "on"),

        ("observacaoHospedagemPublica", "on"),
        ("exibeHospedes", "on"),

        ("diasEntreTrocas", str(dias_entre_trocas)),
        ("tipoAgrupamento", "NENHUM"),
    ]

    # Adiciona os andares
    for andar in andares:
        params.append(("andares", str(andar)))

    nome = (
        "relatorio_governanca_"
        + "_".join(str(a) for a in andares)
        + ".pdf"
    )

    return baixar_relatorio(
        session,
        RELATORIO_GOVERNANCA_URL,
        params,
        nome
    )


def detectar_andares_governanca():
    """
    Detecta a estrutura dos andares a partir do MAPA de UHs.

    O MAPA de UHs lista todas as UHs do hotel, ocupadas ou não,
    então a estrutura fica estável (ao contrário das reservas, que
    só aparecem depois do check-in).

    Se alguma UH pertencer ao andar 0 (térreo):
        0, 1, 2, 3

    Caso contrário:
        1, 2, 3, 4
    """

    uhs = buscar_mapa_uhs().get("uhs") or []

    if not uhs:
        raise RuntimeError(
            "Não foi possível detectar os andares: "
            "o MAPA de UHs não retornou nenhuma UH."
        )

    if any(_uh_no_andar_zero(uh) for uh in uhs):
        return [0, 1, 2, 3]

    return [1, 2, 3, 4]

def imprimir_relatorio_governanca():
    """
    Imprime:

    1. Relatório de todos os andares
    2. Relatório individual de cada andar
    """

    if not _desbravador_cookies:
        raise RuntimeError("Sessão não conectada.")

    body = request.get_json(silent=True) or {}

    dias_entre_trocas = int(
        body.get("dias_entre_trocas", 2)
    )

    if dias_entre_trocas < 0:
        dias_entre_trocas = 0

    session = build_session()

    arquivos = []
    impressos = []

    try:

        # Detecta a estrutura da pousada
        andares = detectar_andares_governanca()

        print(f"[governança] Andares detectados: {andares}")

        # ----------------------------------------------------
        # 1. TODOS OS ANDARES
        # ----------------------------------------------------

        pdf_todos = baixar_relatorio_governanca(
            session,
            andares,
            dias_entre_trocas
        )

        arquivos.append(pdf_todos)

        imprimir_pdf(pdf_todos)

        impressos.append(
            "Governança - Todos os andares"
        )

        # ----------------------------------------------------
        # 2. CADA ANDAR INDIVIDUALMENTE
        # ----------------------------------------------------

        for andar in andares:

            print(
                f"[governança] Imprimindo andar {andar}..."
            )

            pdf = baixar_relatorio_governanca(
                session,
                [andar],
                dias_entre_trocas
            )

            arquivos.append(pdf)

            imprimir_pdf(pdf)

            impressos.append(
                f"Governança - Andar {andar}"
            )

        return {
            "ok": True,
            "relatorio": "governanca",
            "andares": andares,
            "impressos": impressos
        }

    finally:

        for arquivo in arquivos:

            if arquivo.exists():

                try:
                    time.sleep(PRINT_HOLD_SECONDS)
                    arquivo.unlink()

                except OSError:
                    pass



def get_reservas(session):
    url=f"{BASE_URL}/reserva/search"
    params={
        "length":70,"page":1,"valueSearch":"",
        "data.tipoPeriodo.value":"SELECIONE",
        "data.dataInicio.value":"","data.dataFim.value":"",
        "uh.tipoNomeUh.value":"SELECIONE","uh.nomeUh.value":"",
        "numeroReserva.value":"","titular.value":"",
        "situacao.value":"SELECIONE","localizador.value":"",
        "checkinsDoDia.value":"true","reservaOrigem.value":"",
        "channel.value":"true","simboloAdiantamento.value":"R$",
        "advancedFilterActive.value":"false","membership.value":""
    }
    headers={
        "User-Agent":"Mozilla/5.0",
        "Accept":"application/json, text/plain, */*",
        "X-Requested-With":"XMLHttpRequest",
        "Referer":f"{BASE_URL}/#/reserva/"
    }
    r=session.get(url,params=params,headers=headers,timeout=30)
    r.raise_for_status()
    return r.json()

def extrair_dados(data):
    reservas=[]
    for item in data.get("data",[]):
        hospedagens=item.get("details",{}).get("hospedagens",[])
        quartos=[h["abreviaturaUh"] for h in hospedagens if h.get("abreviaturaUh")]
        reservas.append({"id":item["id"],"quartos":quartos})
    return reservas

def listar_reservas_atuais():
    return extrair_dados(get_reservas(build_session()))

def baixar_pdf(session,reserva_id):
    url=f"{BASE_URL}/reserva/manter/gerarRelatorioConfirmacaoReserva/{reserva_id}"
    r=session.get(url,params={"rel":"true","mostraObservacao":"false"},timeout=60)
    r.raise_for_status()
    if "pdf" not in r.headers.get("Content-Type","").lower() and not r.content.startswith(b"%PDF"):
        raise RuntimeError("Resposta não parece ser um PDF.")
    path=get_temp_dir()/f"temp_{secure_filename(str(reserva_id))}.pdf"
    path.write_bytes(r.content)
    return path

def filtrar_pdf_confirmacao(pdf_path):
    pdf_path = Path(pdf_path)

    documento = fitz.open(pdf_path)

    for numero_pagina in range(len(documento)):

        pagina = documento[numero_pagina]

        ocorrencias = pagina.search_for("Informações importantes")

        if ocorrencias:

            inicio = ocorrencias[0]

            print(
                f'"Informações importantes" encontrada na página '
                f'{numero_pagina + 1}'
            )

            # Mantém a página no tamanho e orientação originais.
            # O corte é feito no sistema visual da página.
            area_remover = fitz.Rect(
                pagina.rect.x0,
                inicio.y0,
                pagina.rect.x1,
                pagina.rect.y1
            )

            pagina.add_redact_annot(
                area_remover,
                fill=(1, 1, 1)
            )

            pagina.apply_redactions()

            # Remove todas as páginas posteriores
            if numero_pagina + 1 < len(documento):
                documento.delete_pages(
                    from_page=numero_pagina + 1,
                    to_page=len(documento) - 1
                )

            break

    # Salva em um novo arquivo
    arquivo_filtrado = (
        pdf_path.parent /
        f"{pdf_path.stem}_filtrado.pdf"
    )

    documento.save(arquivo_filtrado)
    documento.close()

    return arquivo_filtrado

def _normalize_printer_name(item):
    if isinstance(item, (tuple, list)):
        for idx in (2, 1, 0):
            if idx < len(item) and isinstance(item[idx], str):
                candidate = item[idx].strip()
                if candidate:
                    if idx == 2 and "," in candidate:
                        candidate = candidate.split(",")[0].strip()
                    if candidate:
                        return candidate
    elif isinstance(item, str):
        return item.strip()
    return None


def get_printers():
    if os.name != "nt":
        return []
    try:
        import win32print
        printers=[]
        for item in win32print.EnumPrinters(2):
            name = _normalize_printer_name(item)
            if name:
                printers.append(name)
        return sorted(set(printers))
    except Exception as exc:
        print(f"[print] get_printers falhou: {exc}")
        return []


def imprimir_via_shell32(path, printer_name=None):
    if os.name != "nt":
        return None

    try:
        shell32 = getattr(ctypes.windll, "shell32", None)
        execute = getattr(shell32, "ShellExecuteW", None)
        if execute is None:
            return None

        if printer_name:
            printer_name = str(printer_name).strip()
            result = execute(None, "printto", str(path.resolve()), printer_name, str(path.parent), 0)
            print(f"[print] ShellExecuteW printer={printer_name} result={result}")
            return result

        return execute(None, "print", str(path.resolve()), None, str(path.parent), 1)
    except Exception as exc:
        print(f"[print] ShellExecuteW falhou: {exc}")
        return None


def set_default_printer(printer_name):
    if os.name != "nt" or not printer_name:
        return False

    try:
        import win32print
        if hasattr(win32print, "SetDefaultPrinter"):
            win32print.SetDefaultPrinter(printer_name)
            return True
    except Exception as exc:
        print(f"[print] Não foi possível definir a impressora padrão: {exc}")

    return False


def imprimir_arquivo(path, printer_name=None):
    path=Path(path)
    if not path.exists(): raise FileNotFoundError(f"Arquivo não encontrado: {path}")

    if os.name == "nt":
        try:
            if printer_name:
                result = imprimir_via_shell32(path, printer_name=printer_name)
                if result is not None and result > 32:
                    return
            os.startfile(str(path.resolve()), "print")
            return
        except Exception as exc:
            print(f"[print] fallback os.startfile falhou: {exc}")

    raise RuntimeError("Impressão não disponível neste ambiente.")


def imprimir_pdf(path):
    if not SUMATRA_PATH.exists():
        raise FileNotFoundError(
            f"SumatraPDF não encontrado: {SUMATRA_PATH}"
        )

    path = Path(path).resolve()

    if not path.exists():
        raise FileNotFoundError(
            f"PDF não encontrado: {path}"
        )

    comando = [
        str(SUMATRA_PATH),
        "-print-to-default",
        str(path)
    ]

    resultado = subprocess.run(
        comando,
        capture_output=True,
        text=True,
        timeout=60
    )

    if resultado.returncode != 0:
        raise RuntimeError(
            f"SumatraPDF retornou código {resultado.returncode}.\n"
            f"{resultado.stderr}"
        )

def imprimir_docx(path, printer_name=None):
    path = Path(path).resolve()

    if not path.exists():
        raise FileNotFoundError(
            f"Arquivo não encontrado: {path}"
        )
    pythoncom.CoInitialize()
    word = Dispatch("Word.Application")
    document = None

    try:
        word.Visible = False
        word.DisplayAlerts = False

        document = word.Documents.Open(
            str(path),
            ReadOnly=True,
            AddToRecentFiles=False,
            ConfirmConversions=False,
            NoEncodingDialog=True
        )

        document.PrintOut(
            Background=False
        )

    finally:
        if document is not None:
            try:
                document.Close(
                    SaveChanges=False
                )
            except Exception:
                pass

        try:
            word.Quit(
                SaveChanges=False
            )
        except Exception:
            pass
        pythoncom.CoUninitialize()

def opcional(path,nome):
    if not path: raise RuntimeError(f"{nome} está ativado, mas sem caminho configurado.")
    p=Path(path)
    if not p.exists(): raise FileNotFoundError(f"{nome} não encontrado: {p}")
    return p

def obter_informativo(quarto):
    """
    Procura o informativo pelo número do quarto,
    independentemente do restante do nome do arquivo.
    """

    if not INFORMATIVOS_ALL_UHS_PATH.exists():
        return INFORMATIVOS_PATH

    numero_quarto = re.sub(r"\D", "", str(quarto))

    if not numero_quarto:
        return INFORMATIVOS_PATH

    # Primeiro procura o número EXATO no nome
    for arquivo in INFORMATIVOS_ALL_UHS_PATH.glob("*.docx"):
        numeros_no_nome = re.findall(r"\d+", arquivo.stem)

        if numero_quarto in numeros_no_nome:
            return arquivo

    # Depois aceita diferença apenas de zeros à esquerda
    numero_sem_zeros = str(int(numero_quarto))

    for arquivo in INFORMATIVOS_ALL_UHS_PATH.glob("*.docx"):
        numeros_no_nome = re.findall(r"\d+", arquivo.stem)

        if numero_sem_zeros in numeros_no_nome:
            return arquivo

    return INFORMATIVOS_PATH

def imprimir_checkin(reserva, printer_name=None, print_settings=None):
    if not _desbravador_cookies: raise RuntimeError("Sessão não conectada.")
    settings = get_print_settings(print_settings)
    hold_seconds = int((print_settings or {}).get("print_hold_seconds", PRINT_HOLD_SECONDS))
    quartos=reserva["quartos"]
    session=build_session()
    quantidade=1 if len(quartos)>2 else max(len(quartos),1)
    impressos=[]
    for _ in range(quantidade):
        if settings["print_ficha"]:
            imprimir_docx(opcional(FICHA_HOSPEDES_PATH,"Ficha_Hospedagem"), printer_name=printer_name)
            impressos.append("Ficha_Hospedagem")
        if settings["print_informativos"]:
            quarto = quartos[_] if _ < len(quartos) else quartos[0]
            informativo = obter_informativo(quarto)

            imprimir_docx(
                opcional(informativo, "Informativo"),
                printer_name=printer_name
            )

            impressos.append(f"Informativo - Quarto {quarto}")
        if settings["print_confirmation"]:
            pdf = None
            pdf_filtrado = None

            try:
                # 1. Baixa a confirmação original
                pdf = baixar_pdf(session, reserva["id"])

                # 2. Filtra as páginas indesejadas
                pdf_filtrado = filtrar_pdf_confirmacao(pdf)

                # 3. Imprime o PDF filtrado
                imprimir_pdf(pdf_filtrado)

                impressos.append(f"Confirmação #{reserva['id']}")

            finally:
                # Remove o PDF original
                if pdf and pdf.exists():
                    try:
                        time.sleep(hold_seconds)
                        pdf.unlink()
                    except OSError:
                        pass

                # Remove o PDF filtrado
                if pdf_filtrado and pdf_filtrado.exists():
                    try:
                        pdf_filtrado.unlink()
                    except OSError:
                        pass
    return {"reserva_id":reserva["id"],"quartos":quartos,"impressos":impressos}

@app.get("/")
def index():
    return render_template("index.html",
        connected=bool(_desbravador_cookies),
        print_confirmation=PRINT_CONFIRMATION,
        print_ficha=PRINT_FICHA_HOSPEDES,
        print_informativos=PRINT_INFORMATIVOS)

@app.route("/api/session", methods=["POST", "OPTIONS"])
def receive_session():
    global _desbravador_cookies
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())

    body=request.get_json(silent=True) or {}
    cookies=body.get("cookies")
    if not isinstance(cookies,list) or not cookies:
        return jsonify(error="Lista de cookies ausente ou vazia."),400
    clean=[{"name":c["name"],"value":c["value"],
            "domain":c.get("domain"),"path":c.get("path","/")}
           for c in cookies if c.get("name") and "value" in c]
    if not clean: return jsonify(error="Nenhum cookie válido recebido."),400
    _desbravador_cookies=clean
    resposta = jsonify(ok=True,cookie_count=len(clean),
                       received_at=datetime.now(timezone.utc).isoformat())
    for chave, valor in _cors_headers().items():
        resposta.headers[chave] = valor
    return resposta

@app.route("/api/session/status", methods=["GET", "OPTIONS"])
def status():
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())
    resposta = jsonify(connected=bool(_desbravador_cookies),
                       cookie_count=len(_desbravador_cookies))
    for chave, valor in _cors_headers().items():
        resposta.headers[chave] = valor
    return resposta

@app.post("/api/reservas")
def reservas():
    try:
        rs=listar_reservas_atuais()
        return jsonify(ok=True,reservas=rs,count=len(rs))
    except Exception as e:
        return jsonify(ok=False,error=str(e)),500

@app.get("/api/printers")
def printers():
    return jsonify(ok=True,printers=get_printers())

@app.post("/api/imprimir/<reserva_id>")
def imprimir(reserva_id):
    try:
        rs=listar_reservas_atuais()
        reserva=next((r for r in rs if str(r["id"])==str(reserva_id)),None)
        if reserva is None: return jsonify(ok=False,error="Reserva não encontrada."),404
        payload=request.get_json(silent=True) or {}
        printer_name=payload.get("printer") or request.args.get("printer")
        return jsonify(ok=True,**imprimir_checkin(reserva, printer_name=printer_name, print_settings=payload))
    except Exception as e:
        return jsonify(ok=False,error=str(e)),500

@app.post("/api/imprimir-lote")
def imprimir_lote():
    try:
        body=request.get_json(silent=True) or {}
        ids=body.get("ids")
        if not isinstance(ids,list) or not ids:
            return jsonify(ok=False,error="Lista de reservas ausente ou vazia."),400

        rs=listar_reservas_atuais()
        mapa={str(r["id"]):r for r in rs}
        impressos=[]
        erros=[]

        for reserva_id in ids:
            chave=str(reserva_id)
            reserva=mapa.get(chave)
            if reserva is None:
                erros.append({"id":chave,"error":"Reserva não encontrada."})
                continue
            try:
                printer_name=body.get("printer")
                impressos.append(imprimir_checkin(reserva, printer_name=printer_name, print_settings=body))
            except Exception as e:
                erros.append({"id":chave,"error":str(e)})

        return jsonify(ok=not erros,printed=impressos,errors=erros,count=len(impressos))
    except Exception as e:
        return jsonify(ok=False,error=str(e)),500

@app.post("/api/relatorio/checkin")
def relatorio_checkin():
    try:
        resultado = imprimir_relatorio_checkin_dia()

        return jsonify(resultado)

    except Exception as e:
        return jsonify(
            ok=False,
            error=str(e)
        ), 500

@app.post("/api/relatorio/governanca")
def relatorio_governanca():
    try:
        resultado = imprimir_relatorio_governanca()

        return jsonify(resultado)

    except Exception as e:
        return jsonify(
            ok=False,
            error=str(e)
        ), 500

@app.get("/api/teste-relatorio-checkin")
def teste_relatorio_checkin():

    if not _desbravador_cookies:
        return jsonify(
            ok=False,
            error="Sessão não conectada."
        ), 400

    pdf = None

    try:

        session = build_session()

        data = datetime.now().strftime("%d/%m/%Y")

        params = [
            ("rel", "true"),
            ("tipoRelatorio", "DETALHADO"),
            ("pessoaTitular.id", ""),
            ("pessoaTitular.razaoNome", ""),
            ("dataInicio", data),
            ("dataFim", data),
            ("ordenacao", "RESERVA"),
            ("exibirHospedeClassificacao", "on"),
            ("listarObservacaoDosHospedes", "on"),
            ("listarObservacaoPublicaDaHospedagem", "on"),
        ]

        pdf = baixar_relatorio_pdf(
            session,
            RELATORIO_CHECKIN_URL,
            params,
            "teste_checkin.pdf"
        )

        texto = extrair_totais_relatorio(pdf)

        print("=" * 60)
        print("RELATÓRIO CHECK-IN")
        print("=" * 60)
        print(texto)
        print("=" * 60)

        return jsonify(
            ok=True,
            texto=texto
        )

    except Exception as e:

        return jsonify(
            ok=False,
            error=str(e)
        ), 500

    finally:

        if pdf and pdf.exists():
            try:
                pdf.unlink()
            except OSError:
                pass

@app.get("/api/teste-relatorio-checkout")
def teste_relatorio_checkout():

    if not _desbravador_cookies:
        return jsonify(
            ok=False,
            error="Sessão não conectada."
        ), 400

    pdf = None

    try:

        session = build_session()

        data = datetime.now().strftime("%d/%m/%Y")

        params = [
            ("rel", "true"),
            ("dataInicial", data),
            ("dataFinal", data),
        ]

        pdf = baixar_relatorio_pdf(
            session,
            RELATORIO_CHECKOUT_URL,
            params,
            "teste_checkout.pdf"
        )

        texto = extrair_totais_relatorio(pdf)

        totais = extrair_totais_checkout(texto)

        print("=" * 60)
        print("RELATÓRIO CHECK-OUT")
        print("=" * 60)
        print(texto)
        print("=" * 60)
        print("TOTAIS:", totais)
        print("=" * 60)

        return jsonify(
            ok=True,
            totais=totais,
            texto=texto
        )

    except Exception as e:

        return jsonify(
            ok=False,
            error=str(e)
        ), 500

    finally:

        if pdf and pdf.exists():
            try:
                pdf.unlink()
            except OSError:
                pass

@app.get("/api/teste-ocupacao-atual")
def teste_ocupacao_atual():

    if not _desbravador_cookies:
        return jsonify(
            ok=False,
            error="Sessão não conectada."
        ), 400

    pdf = None

    try:

        session = build_session()

        data = datetime.now().strftime("%d/%m/%Y")

        params = [
            ("rel", "true"),
            ("tipoListagem", "CAFE_PENSAO"),
            ("titular.id", ""),
            ("tipoDataAConsiderar", data),
            ("data", data),
            ("uhTipo.id", ""),
        ]

        pdf = baixar_relatorio_pdf(
            session,
            RELATORIO_OCUPACAO_URL,
            params,
            "teste_ocupacao.pdf"
        )

        texto = extrair_totais_relatorio(pdf)
      # VOLTAR AQUI
        totais = extrair_ocupacao_atual(texto)

        print("=" * 60)
        print("OCUPAÇÃO ATUAL")
        print("=" * 60)
        print("TOTAIS:", totais)
        print("=" * 60)

        return jsonify(
            ok=True,
            totais=totais,
            texto=texto
        )

    except Exception as e:

        return jsonify(
            ok=False,
            error=str(e)
        ), 500

    finally:

        if pdf and pdf.exists():
            try:
                pdf.unlink()
            except OSError:
                pass


@app.get("/api/previsao-cafe")
def previsao_cafe():

    if not _desbravador_cookies:
        return jsonify(
            ok=False,
            error="Sessão não conectada."
        ), 400

    pdfs = []

    try:
        session = build_session()

        hoje = datetime.now()
        data_hoje = hoje.strftime("%d/%m/%Y")

        # =====================================================
        # 1. OCUPAÇÃO ATUAL
        # =====================================================

        params_ocupacao = [
            ("rel", "true"),
            ("tipoListagem", "CAFE_PENSAO"),
            ("titular.id", ""),
            ("tipoDataAConsiderar", data_hoje),
            ("data", data_hoje),
            ("uhTipo.id", ""),
        ]

        pdf_ocupacao = baixar_relatorio_pdf(
            session,
            RELATORIO_OCUPACAO_URL,
            params_ocupacao,
            "previsao_ocupacao.pdf"
        )

        pdfs.append(pdf_ocupacao)

        texto_ocupacao = extrair_totais_relatorio(
            pdf_ocupacao
        )

        ocupacao = extrair_ocupacao_atual(
            texto_ocupacao
        )

        # =====================================================
        # 2. CHECK-IN
        # =====================================================

        params_checkin = [
            ("rel", "true"),
            ("tipoRelatorio", "DETALHADO"),
            ("pessoaTitular.id", ""),
            ("pessoaTitular.razaoNome", ""),
            ("dataInicio", data_hoje),
            ("dataFim", data_hoje),
            ("ordenacao", "RESERVA"),
            ("exibirHospedeClassificacao", "on"),
            ("listarObservacaoDosHospedes", "on"),
            ("listarObservacaoPublicaDaHospedagem", "on"),
        ]

        pdf_checkin = baixar_relatorio_pdf(
            session,
            RELATORIO_CHECKIN_URL,
            params_checkin,
            "previsao_checkin.pdf"
        )

        pdfs.append(pdf_checkin)

        texto_checkin = extrair_totais_relatorio(
            pdf_checkin
        )

        checkin = extrair_totais_checkin(
            texto_checkin
        )

        # =====================================================
        # 3. CHECK-OUT
        # =====================================================

        params_checkout = [
            ("rel", "true"),
            ("dataInicial", data_hoje),
            ("dataFinal", data_hoje),
        ]

        pdf_checkout = baixar_relatorio_pdf(
            session,
            RELATORIO_CHECKOUT_URL,
            params_checkout,
            "previsao_checkout.pdf"
        )

        pdfs.append(pdf_checkout)

        texto_checkout = extrair_totais_relatorio(
            pdf_checkout
        )

        checkout = extrair_totais_checkout(
            texto_checkout
        )

        # =====================================================
        # 4. CÁLCULO
        # =====================================================

        uh_amanha = (
            ocupacao["uh"]
            + checkin["uh"]
            - checkout["uh"]
        )

        pax_amanha = (
            ocupacao["pax"]
            + checkin["pax"]
            - checkout["pax"]
        )

        # =====================================================
        # 5. RESULTADO
        # =====================================================

        return jsonify({
            "ok": True,

            "data": data_hoje,

            "uh_atual": ocupacao["uh"],
            "pax_atual": ocupacao["pax"],

            "checkin_uh": checkin["uh"],
            "checkin_pax": checkin["pax"],

            "checkout_uh": checkout["uh"],
            "checkout_pax": checkout["pax"],

            "uh_amanha": uh_amanha,
            "pax_amanha": pax_amanha
        })

    except Exception as e:

        return jsonify({
            "ok": False,
            "error": str(e)
        }), 500

    finally:

        for pdf in pdfs:
            try:
                if pdf.exists():
                    pdf.unlink()
            except OSError:
                pass


@app.get("/health")
def health(): return jsonify(ok=True)

def _exige_sessao():
    if not _desbravador_cookies:
        return jsonify(ok=False, error="Sessão não conectada."), 400
    return None

# ============================================================
# MAPA DE UHs + EXTRATO + CONFERÊNCIA DE COMANDAS
# ============================================================

URL_MAPA_UH_JSON = f"{BASE_URL}/mapaUh/contentMapaUh"
URL_EXTRATO      = f"{BASE_URL}/extratoContaHospedagem"
URL_INFO         = f"{BASE_URL}/extratoContaHospedagem/informacoes"

CONFERENCIA_FILE = APP_DIR / "conferencia.json"


# ---------------------- persistência ------------------------
def carregar_conferencia():
    if not CONFERENCIA_FILE.exists():
        return {}
    try:
        return json.loads(CONFERENCIA_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def salvar_conferencia(dados):
    CONFERENCIA_FILE.write_text(
        json.dumps(dados, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

# ---------------------- helpers -----------------------------
def _parse_moeda(txt):
    if txt is None:
        return 0.0
    if isinstance(txt, (int, float)):
        return float(txt)
    s = re.sub(r"[^\d,.-]", "", str(txt))
    if not s or s in ("-", ".", ","):
        return 0.0
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0


def _extrair_andar(numero_uh):
    digits = re.sub(r"\D", "", str(numero_uh))
    if not digits:
        return 0
    if digits.startswith("0"):
        digits = digits.lstrip("0") or "0"
    if len(digits) >= 3:
        return int(digits[:-2]) or 0
    return int(digits[0])


# ============================================================
# MAPA DE UHs — /mapaUh/contentMapaUh
# ============================================================

def _headers_mapa_uh():
    return {
        "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/153.0.0.0 Safari/537.36",
        "Accept":           "*/*",
        "Accept-Language":  "pt-BR,pt;q=0.6",
        "Cache-Control":    "no-cache",
        "Pragma":           "no-cache",
        "X-Requested-With": "XMLHttpRequest",
        "Referer":          f"{BASE_URL}/",
    }


SITUACOES_CONHECIDAS = (
    "CHECKIN_OCUPADA_CHECKOUT",
    "OCUPADA_CHECKOUT",
    "CHECKIN_OCUPADA",
    "CHECKIN_CHECKOUT",
    "CHECK_OUT",
    "CHECKIN",
    "CHECKOUT",
    "OCUPADA",
    "LIMPEZA",
    "LIVRE",
    "MANUTENCAO",
)


def _normalizar_situacao(raw):
    """Normaliza a situacao vinda do Desbravador.

    O Desbravador pode devolver variacoes como 'Check-in/Check-out',
    'CHECKIN_OCUPADA_CHECKOUT', 'Ocupada - Saida Hoje', etc.
    Aqui transformamos tudo numa chave canonica em MAIUSCULAS com '_'.
    """
    if not raw:
        return "OCUPADA"
    s = str(raw).upper().strip()
    s = re.sub(r"[\s\-/]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    # tenta casar com a lista conhecida (prefixo mais longo)
    for conhecida in sorted(SITUACOES_CONHECIDAS, key=len, reverse=True):
        if conhecida in s:
            return conhecida
    return s


def _normalizar_uh_mapa(item):
    pop = item.get("popover") or {}
    try:
        andar = int(str(pop.get("andar") or 0).strip() or 0)
    except (TypeError, ValueError):
        andar = 0

    return {
        "id":           item.get("id"),
        "numero":       item.get("descricao") or pop.get("identificacaoUh") or "",
        "tipo":         item.get("descricaoUhTipo") or "",
        "tipoNome":     pop.get("identificacaoUhTipo") or "",
        "situacao":     _normalizar_situacao(item.get("situacao")),
        "cor":          item.get("cor"),
        "modoOcupacao": item.get("modoOcupacao"),
        "andar":        andar,
        "hospede":      pop.get("titular"),
        "reserva":      pop.get("idReserva"),
        "reserva_id":   pop.get("idHospedagem"),
        "saida":        pop.get("dataOut"),
        "dataIn":       pop.get("dataIn"),
        "hospedagemId": pop.get("idHospedagem"),
        "qtdHospede":   item.get("quantidadeHospede"),
        "horaIn":       item.get("horaIn"),
        "horaOut":      item.get("horaOut"),
        "idManutencao": item.get("idManutencao"),
        "observacao":   pop.get("observacaoManutencao") or "",
        "tem_extrato":  bool(pop.get("idHospedagem")),
    }

# ============================================================
# MAPA DE UHs — /mapaUh/contentMapaUh?json={...}
# ============================================================

# URL_MAPA_UH_JSON já definida acima (seção "MAPA DE UHs")

# Filtro vazio — exatamente como o SPA manda
FILTRO_MAPA_UH_VAZIO = {
    "modos":         [],
    "generos":       [],
    "situacoes":     [],
    "uhsTipo":       [],
    "andares":       [],
    "caracteristicas": [],
    "conjugadas":    [],
    "cama":          False,
    "quarto":        False,
}


def _url_mapa_uh(filtro=None):
    """
    Monta a URL com o query param `json=` igual ao que o SPA manda.
    """
    f = filtro or FILTRO_MAPA_UH_VAZIO
    json_str = json.dumps(f, separators=(",", ":"), ensure_ascii=False)
    # requests cuida do encode; basta passar como params
    return URL_MAPA_UH_JSON, {"json": json_str}


def buscar_mapa_uhs(session=None):
    """
    Baixa o MAPA de UHs do Desbravador e devolve o JSON cru.

    O MAPA lista todas as UHs do hotel, independente de estarem
    ocupadas, por isso é a base para descobrir a estrutura de
    andares da pousada.
    """
    session = session or build_session()
    url, params = _url_mapa_uh()

    r = session.get(url, params=params,
                    headers=_headers_mapa_uh(), timeout=30)
    r.raise_for_status()

    return r.json()


def _uh_no_andar_zero(uh):
    """Indica se a UH do MAPA pertence ao andar 0 (térreo)."""
    pop = uh.get("popover") or {}

    andar = pop.get("andar")

    if andar is not None and str(andar).strip() != "":
        try:
            return int(str(andar).strip()) == 0
        except (TypeError, ValueError):
            pass

    # Sem o andar no MAPA, cai para o primeiro dígito do número da UH
    numero = re.sub(
        r"\D", "",
        str(uh.get("descricao") or pop.get("identificacaoUh") or "")
    )

    return bool(numero) and numero.startswith("0")


@app.get("/api/mapa-uhs")
def api_mapa_uhs():
    erro = _exige_sessao()
    if erro:
        return erro

    session = build_session()
    url, params = _url_mapa_uh()

    r = session.get(url, params=params,
                    headers=_headers_mapa_uh(), timeout=30)

    if r.status_code != 200:
        try:
            (get_temp_dir() / "mapaUh_erro.html").write_bytes(r.content)
        except Exception:
            pass
        return jsonify(
            ok=False,
            error=f"HTTP {r.status_code} em /mapaUh/contentMapaUh",
            status=r.status_code,
            ctype=r.headers.get("Content-Type", ""),
            amostra=r.text[:800],
            url_chamada=r.url,
        ), 502

    try:
        dados = r.json()
    except Exception:
        return jsonify(ok=False, error="Resposta 200 mas não é JSON",
                       amostra=r.text[:400]), 502

    uhs_raw = dados.get("uhs") or []
    uhs = sorted(
        [_normalizar_uh_mapa(u) for u in uhs_raw],
        key=lambda u: (u["andar"], u["numero"])
    )

    return jsonify(
        ok=True,
        uhs=uhs,
        total=len(uhs),
        dataCaixa=dados.get("dataCaixa"),
        simboloMoeda=dados.get("simboloMoedaPadrao", "R$"),
        habilitaEmprestimo=dados.get("habilitaEmprestimoItems", False),
    )

# ============================================================
# EXTRATO — parser de comandas
# ============================================================
class _DivLancamentoParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.itens = []
        self._atual = None
        self._stack_div = []
        self._buf = []
        self._capturando = False
        self._div_depths = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "div":
            classes = (a.get("class") or "").split()
            id_ = a.get("id") or ""
            if id_.startswith("div-lancamento-") and "extrato-div-comandas" in classes:
                self._atual = {
                    "idLancamento": a.get("data-idlancamento"),
                    "data": {k[5:]: v for k, v in a.items() if k.startswith("data-")},
                    "textos": {},
                    "inputs": {},
                    "hidden": {},
                }
                self._stack_div = [classes]
                self._capturando = True
                self._div_depths = 1
                self._buf = []
                return
            if self._capturando:
                self._stack_div.append(classes or [""])
                self._div_depths += 1
                self._buf = []
            return

        if self._capturando and tag == "input":
            val = a.get("value", "")
            id_ = a.get("id") or ""
            name = a.get("name") or ""
            classes = (a.get("class") or "").split()
            if a.get("type") == "hidden":
                key = name or id_
                if key:
                    self._atual["hidden"][key] = val
            else:
                if id_:
                    self._atual["inputs"][id_] = val
                for cls in ("ext-lancamento-quantidade",
                            "ext-lancamento-valor-unitario"):
                    if cls in classes and val:
                        self._atual["inputs"][cls] = val
            return

        if self._capturando and tag == "a":
            sigla = a.get("data-sigla-pdv")
            if sigla:
                self._atual["data"]["sigla_pdv"] = sigla

    def handle_data(self, data):
        if self._capturando and self._buf is not None:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if not self._capturando:
            return
        if tag == "div":
            if self._stack_div:
                classes = self._stack_div.pop()
                txt = " ".join("".join(self._buf).split())
                if txt:
                    for cls in ("label-item", "label-data", "label-pdv",
                                "label-comanda", "ext-lancamento-valor-taxas",
                                "extrato-valorTotalReal", "ext-lancamento-valor-iva"):
                        if cls in classes and cls not in self._atual["textos"]:
                            self._atual["textos"][cls] = txt
                            break
                self._buf = []
            self._div_depths -= 1
            if self._div_depths <= 0:
                self.itens.append(self._atual)
                self._atual = None
                self._capturando = False
                self._stack_div = []
                self._div_depths = 0


def _descricao_limpa(descricao):
    """Remove o prefixo de codigo do item: '9900 - DIARIA' -> 'DIARIA'."""
    if not descricao:
        return ""
    return re.sub(r"^\s*\d+\s*-\s*", "", descricao).strip()


def _eh_diaria(descricao):
    """Diaria = descricao contem DIARIA/DIÁRIA/HOSPEDAGEM (sem acento)."""
    if not descricao:
        return False
    s = descricao.upper()
    # remove acentos comuns
    s = (s.replace("Á", "A").replace("À", "A").replace("Â", "A")
           .replace("Ã", "A").replace("É", "E").replace("Ê", "E")
           .replace("Í", "I").replace("Ó", "O").replace("Ô", "O")
           .replace("Õ", "O").replace("Ú", "U"))
    return ("DIARIA" in s) or ("HOSPEDAGEM" in s)


def parsear_extrato_html(html, numero_uh):
    parser = _DivLancamentoParser()
    parser.feed(html)
    diarias, comandas = [], []
    for raw in parser.itens:
        d = raw["data"]
        textos = raw["textos"]
        inputs = raw["inputs"]
        id_lanc = raw["idLancamento"] or d.get("idlancamento") or ""
        descricao = (textos.get("label-item") or "").strip()
        comanda_num = (textos.get("label-comanda") or "").strip()
        pdv = (d.get("sigla_pdv") or textos.get("label-pdv") or "").strip()
        data_str = (textos.get("label-data") or "").strip()
        qtd = _parse_moeda(d.get("quantidade") or inputs.get("ext-lancamento-quantidade") or 1)
        valor = _parse_moeda(d.get("valor") or inputs.get("ext-lancamento-valor-unitario") or 0)
        total = _parse_moeda(d.get("total") or textos.get("extrato-valorTotalReal") or valor)
        categoria = (d.get("categoria") or "").upper()
        cortesia = (d.get("item-cortesia") or "").lower() == "true"
        item = {
            "id": id_lanc,
            "descricao": _descricao_limpa(descricao),
            "descricao_original": descricao,
            "comanda": comanda_num,
            "qtd": int(qtd) or 1,
            "valor": round(valor, 2),
            "total": round(total, 2),
            "data": data_str,
            "pdv": pdv,
            "categoria": categoria,
            "cortesia": cortesia,
            "uh": numero_uh,
        }
        if _eh_diaria(descricao):
            diarias.append(item)
        else:
            comandas.append(item)

    ocupacao = None
    if re.search(r"particular", html, re.IGNORECASE):
        ocupacao = "PARTICULAR"
    elif re.search(r"empresa|cnpj", html, re.IGNORECASE):
        ocupacao = "EMPRESA"

    return {"uh": numero_uh, "ocupacao": ocupacao,
            "diarias": diarias, "comandas": comandas}


def _headers_extrato(reserva_id):
    return {
        "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept":           "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language":  "pt-BR,pt;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer":          f"{BASE_URL}/#/extratoContaHospedagem/{reserva_id}",
        "Origin":           BASE_URL,
    }


@app.get("/api/uh/<int:reserva_id>/<numero_uh>/extrato")
def api_extrato_uh(reserva_id, numero_uh):
    erro = _exige_sessao()
    if erro:
        return erro

    session = build_session()
    headers = _headers_extrato(reserva_id)

    out = {"uh": numero_uh, "reserva": reserva_id, "ocupacao": None,
           "diarias": [], "comandas": [], "totais": {}, "info": {}, "debug": {}}

    try:
        r = session.get(f"{URL_INFO}/{reserva_id}", headers=headers, timeout=30)
        out["debug"]["info_status"] = r.status_code
        if r.status_code == 200:
            try:
                info = r.json()
            except Exception:
                info = []
            out["info"] = info
            for campo in info:
                k = (campo.get("key") or "").lower()
                v = (campo.get("value") or "")
                if "particular" in v.lower():
                    out["ocupacao"] = "PARTICULAR"
                elif "empresa" in v.lower() or "cnpj" in v.lower():
                    out["ocupacao"] = "EMPRESA"
    except Exception as e:
        out["debug"]["info_erro"] = str(e)

    try:
        r = session.get(f"{URL_EXTRATO}/{reserva_id}", headers=headers, timeout=30)
        out["debug"]["extrato_status"] = r.status_code
        r.raise_for_status()
        html = r.text
        try:
            (get_temp_dir() / f"extrato_{reserva_id}_{numero_uh}.html").write_text(html, encoding="utf-8")
        except Exception:
            pass
        parsed = parsear_extrato_html(html, numero_uh)
        out["diarias"] = parsed["diarias"]
        out["comandas"] = parsed["comandas"]
        if parsed["ocupacao"] and not out["ocupacao"]:
            out["ocupacao"] = parsed["ocupacao"]
        out["totais"] = {
            "diarias_total":  round(sum(d["valor"] for d in out["diarias"]), 2),
            "comandas_total": round(sum(c["valor"] for c in out["comandas"]), 2),
            "geral_total":    round(sum(d["valor"] for d in out["diarias"])
                                    + sum(c["valor"] for c in out["comandas"]), 2),
            "qtd_diarias":    len(out["diarias"]),
            "qtd_comandas":   len(out["comandas"]),
        }
        return jsonify(ok=True, **out)
    except Exception as e:
        return jsonify(ok=False, error=str(e), debug=out["debug"]), 500


# ============================================================
# CONFERÊNCIA — persistência
# ============================================================
@app.post("/api/conferencia")
def api_salvar_conferencia():
    body = request.get_json(silent=True) or {}
    if "uh_id" not in body:
        return jsonify(ok=False, error="uh_id é obrigatório."), 400
    estado = carregar_conferencia()
    estado[str(body["uh_id"])] = {
        "status":   body.get("status", "pendente"),
        "comandas": body.get("comandas", {}),
        "obs":      body.get("obs", ""),
        "total":    body.get("total", 0),
        "ts":       datetime.now(timezone.utc).isoformat(),
    }
    salvar_conferencia(estado)
    return jsonify(ok=True, total=len(estado))


@app.get("/api/conferencia")
def api_ler_conferencia():
    return jsonify(ok=True, dados=carregar_conferencia())


@app.post("/api/conferencia/limpar")
def api_limpar_conferencia():
    salvar_conferencia({})
    return jsonify(ok=True, msg="Conferência zerada.")


# ============================================================
# IMPRESSÃO DOS EXTRATOS — enviada pelo "Modo conferência" (extensão)
# ============================================================
EXTRATO_PDF_CSS = """
h1 { font-size: 14pt; margin: 0 0 2pt 0; }
.doc { font-size: 8pt; color: #555555; margin: 0 0 8pt 0; }
.meta { font-size: 9pt; margin: 0 0 2pt 0; }
.sec { font-size: 10pt; font-weight: bold; margin: 10pt 0 3pt 0; }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
th { background-color: #eeeeee; text-align: left; font-size: 8pt;
     border-bottom: 1pt solid #999999; padding: 2pt 3pt; }
td { border-bottom: 0.5pt solid #dddddd; padding: 2pt 3pt; }
td.n, th.n { text-align: right; }
tr.tot td { font-weight: bold; border-top: 0.5pt solid #999999; }
.vazio { color: #666666; font-style: italic; }
.assin { margin-top: 24pt; font-size: 8pt; }
"""


def _cors_headers():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    }


def _esc(v):
    return (str("" if v is None else v)
            .replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _moeda_br(v):
    try:
        n = float(v or 0)
    except (TypeError, ValueError):
        n = 0.0
    inteiro, _, dec = f"{n:,.2f}".partition(".")
    inteiro = inteiro.replace(",", ".")
    return f"R$ {inteiro},{dec}"


def _html_extrato_uh(u):
    comandas = u.get("comandas") or []
    diarias = u.get("diarias") or []

    def linhas(itens, da_diaria):
        if not itens:
            return ('<tr><td colspan="7" class="vazio">'
                    + ("Nenhuma diária faturada." if da_diaria else "Nenhuma comanda lançada.")
                    + "</td></tr>")
        out = []
        for it in itens:
            valor = it.get("valor") or 0
            total = it.get("total") or valor
            cortesia = ' <b>[CORTESIA]</b>' if it.get("cortesia") else ""
            out.append(
                "<tr>"
                f"<td>{_esc(it.get('comanda') or '—')}</td>"
                f"<td>{_esc(it.get('descricao'))}{cortesia}</td>"
                f"<td class='n'>{int(it.get('qtd') or 1)}</td>"
                f"<td>{_esc(it.get('pdv') or '—')}</td>"
                f"<td class='n'>{_moeda_br(valor)}</td>"
                f"<td class='n'>{_moeda_br(total)}</td>"
                f"<td>{_esc(it.get('data') or '—')}</td>"
                "</tr>"
            )
        return "".join(out)

    soma_com = sum(float(c.get("total") or c.get("valor") or 0) for c in comandas)
    soma_dia = sum(float(d.get("total") or d.get("valor") or 0) for d in diarias)

    cabecalho = (
        "<thead><tr>"
        "<th style='width:60pt'>N° Comanda</th><th>Descrição</th>"
        "<th class='n' style='width:28pt'>Qtd</th><th style='width:40pt'>PDV</th>"
        "<th class='n' style='width:62pt'>Valor</th><th class='n' style='width:62pt'>Total</th>"
        "<th style='width:70pt'>Data</th>"
        "</tr></thead>"
    )

    return (
        f"<h1>Extrato de Conta — UH {_esc(u.get('numero'))}</h1>"
        f"<div class='doc'>Conferência de comandas · emitido em "
        f"{_esc(datetime.now().strftime('%d/%m/%Y %H:%M'))}</div>"
        "<div class='meta'>"
        f"<b>Tipo:</b> {_esc(u.get('tipo') or '—')} &nbsp;&nbsp; "
        f"<b>Reserva:</b> {_esc(u.get('reserva') or '—')} &nbsp;&nbsp; "
        f"<b>Conta:</b> {_esc(u.get('conta') or '—')} &nbsp;&nbsp; "
        f"<b>Saída:</b> {_esc(u.get('saida') or '—')} &nbsp;&nbsp; "
        f"<b>Ocupação:</b> {_esc(u.get('ocupacao') or '—')}"
        "</div>"
        f"<div class='meta'><b>Hóspede:</b> {_esc(u.get('hospede') or '—')}</div>"
        f"<div class='sec'>Comandas ({len(comandas)})</div>"
        f"<table>{cabecalho}<tbody>{linhas(comandas, False)}</tbody>"
        f"<tbody><tr class='tot'><td colspan='5' class='n'>Total das comandas</td>"
        f"<td class='n'>{_moeda_br(soma_com)}</td><td></td></tr></tbody></table>"
        f"<div class='sec'>Diárias / Hospedagem ({len(diarias)})</div>"
        f"<table>{cabecalho}<tbody>{linhas(diarias, True)}</tbody>"
        f"<tbody><tr class='tot'><td colspan='5' class='n'>Total das diárias</td>"
        f"<td class='n'>{_moeda_br(soma_dia)}</td><td></td></tr></tbody></table>"
        "<div class='assin'>Conferido por: ______________________________</div>"
    )


def _pdf_extratos(uhs, destino):
    """Gera um PDF com UMA página por UH (PyMuPDF Story)."""
    writer = fitz.DocumentWriter(str(destino))
    mediabox = fitz.paper_rect("a4")
    where = mediabox + (36, 36, -36, -36)   # margens

    for u in uhs:
        story = fitz.Story(html=_html_extrato_uh(u), user_css=EXTRATO_PDF_CSS)
        while True:
            pagina = writer.begin_page(mediabox)
            mais, _ = story.place(where)
            story.draw(pagina)
            writer.end_page()
            if not mais:
                break

    writer.close()
    return destino


@app.route("/api/imprimir-pdfs", methods=["POST", "OPTIONS"])
def api_imprimir_pdfs():
    """Recebe os extratos já em PDF (base64) gerados pelo Desbravador,
    junta tudo num único documento e imprime.

    Espera JSON: { "pdfs": [ {"numero": "208", "base64": "..."} ], "printer": "opcional" }
    """
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())

    payload = request.get_json(silent=True) or {}
    pdfs = payload.get("pdfs") or []
    if not isinstance(pdfs, list) or not pdfs:
        return jsonify(ok=False, error="Nenhum PDF recebido para impressão."), 400

    try:
        juntado = fitz.open()
        numeros = []
        for item in pdfs:
            dados = base64.b64decode(item.get("base64") or "")
            if not dados:
                continue
            parcial = fitz.open(stream=dados, filetype="pdf")
            juntado.insert_pdf(parcial)
            parcial.close()
            numeros.append(item.get("numero"))

        if not juntado.page_count:
            juntado.close()
            return jsonify(ok=False, error="Os PDFs recebidos estão vazios."), 400

        destino = get_temp_dir() / (
            "extratos_conferencia_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".pdf"
        )
        juntado.save(str(destino))
        total_paginas = juntado.page_count
        juntado.close()
        print(f"[extratos] PDF unido: {destino} ({len(numeros)} UH(s), {total_paginas} página(s))")

        printer = payload.get("printer") or request.args.get("printer")
        if printer:
            imprimir_arquivo(destino, printer_name=printer)
        else:
            imprimir_pdf(destino)

        resposta = jsonify(
            ok=True,
            impressos=len(numeros),
            uhs=numeros,
            paginas=total_paginas,
            pdf=str(destino)
        )
        for chave, valor in _cors_headers().items():
            resposta.headers[chave] = valor
        return resposta

    except Exception as exc:
        resposta = jsonify(ok=False, error=str(exc))
        for chave, valor in _cors_headers().items():
            resposta.headers[chave] = valor
        return resposta, 500


@app.route("/api/imprimir-extratos", methods=["POST", "OPTIONS"])
def api_imprimir_extratos():
    """Recebe os extratos do 'Modo conferência' e imprime.

    Espera JSON: { "uhs": [ { numero, tipo, reserva, conta, hospede, saida,
                              comandas: [...], diarias: [...] } ], "printer": "opcional" }
    """
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers())

    payload = request.get_json(silent=True) or {}
    uhs = payload.get("uhs") or []
    if not isinstance(uhs, list) or not uhs:
        return jsonify(ok=False, error="Nenhuma UH enviada para impressão."), 400

    try:
        destino = get_temp_dir() / (
            "extratos_conferencia_" + datetime.now().strftime("%Y%m%d_%H%M%S") + ".pdf"
        )
        _pdf_extratos(uhs, destino)
        print(f"[extratos] PDF gerado: {destino} ({len(uhs)} UH(s))")

        printer = payload.get("printer") or request.args.get("printer")
        if printer:
            imprimir_arquivo(destino, printer_name=printer)
        else:
            imprimir_pdf(destino)

        resposta = jsonify(
            ok=True,
            impressos=len(uhs),
            uhs=[u.get("numero") for u in uhs],
            pdf=str(destino),
        )
        for chave, valor in _cors_headers().items():
            resposta.headers[chave] = valor
        return resposta

    except Exception as exc:
        resposta = jsonify(ok=False, error=str(exc))
        for chave, valor in _cors_headers().items():
            resposta.headers[chave] = valor
        return resposta, 500


# ============================================================
# TELA
# ============================================================
@app.get("/conferencia")
def pagina_conferencia():
    return render_template(
        "conferencia.html",
        cores_tipo={
            "DVM":   "#4986e7",
            "AFMEC": "#f691b2",
            "AFML":  "#a47ae2",
            "PNE":   "#16a765",
            "STD":   "#f83a22",
            "STDEC": "#d06b64",
        },
        data_caixa=datetime.now().strftime("%d/%m/%Y"),
        connected=bool(_desbravador_cookies),
    )


# ============================================================
# DEBUG
# ============================================================
@app.get("/api/debug/mapa-uh-raw")
def api_debug_mapa_uh_raw():
    """Baixa /mapaUh/contentMapaUh e mostra o que veio."""
    erro = _exige_sessao()
    if erro:
        return erro
    session = build_session()
    r = session.get(URL_MAPA_UH_JSON, headers=_headers_mapa_uh(), timeout=30)
    return jsonify(
        ok=True,
        status=r.status_code,
        ctype=r.headers.get("Content-Type", ""),
        tamanho=len(r.content),
        amostra=r.text[:1500],
        cookies=len(session.cookies),
    )

if __name__=="__main__":
    app.run(host="127.0.0.1",port=8000,debug=False)
