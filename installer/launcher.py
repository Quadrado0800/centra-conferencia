#!/usr/bin/env python3
"""Launcher / supervisor da Central do Recepcionista.

Fica residente em segundo plano e:

* arranca o ``app.exe`` (Flask em 127.0.0.1:8000) escondido;
* vigia o processo e volta a arranca-lo se este morrer (sempre activo);
* serve o CRX + ``updates.xml`` da extensao do Chrome em
  ``http://127.0.0.1:8011`` (e esse o ``update_url`` gravado na politica);
* garante que o ``app.exe`` morre junto com o launcher (Job Object).

Nunca abre janela: toda a informacao vai para ``logs\\launcher.log``.

Uso:
    CentralRecepcionistaLauncher.exe                     (supervisiona)
    CentralRecepcionistaLauncher.exe --stop               (para tudo)
    CentralRecepcionistaLauncher.exe --chrome-extension-help
"""

from __future__ import annotations

import argparse
import ctypes
import http.server
import logging
import logging.handlers
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from ctypes import wintypes

DEFAULT_APP_EXE = "Central_Recepcionist_conf_plus_printer.exe"
LAUNCHER_NAME = "CentralRecepcionistaLauncher.exe"
CRX_DIR_NAME = "crx"
CRX_PORT = 8011

APP_HOST = "127.0.0.1"
DEFAULT_APP_PORT = 8000
HEALTH_PATH = "/api/session/status"

CREATE_NO_WINDOW = 0x08000000
MUTEX_NAME = "Local\\CentralRecepcionistaLauncher"
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JobObjectExtendedLimitInformation = 9

CHROME_CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
)

log = logging.getLogger("launcher")


# --------------------------------------------------------------------------
# infraestrutura Windows
# --------------------------------------------------------------------------
def detect_app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def detect_launcher_path() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve()
    return Path(__file__).resolve()


def setup_logging(app_dir: Path) -> None:
    log_dir = app_dir / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return

    handler = logging.handlers.RotatingFileHandler(
        log_dir / "launcher.log", maxBytes=512_000, backupCount=2, encoding="utf-8"
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")
    )
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


def find_app_exe(app_dir: Path, explicit: str | None) -> Path:
    if explicit:
        candidate = Path(explicit)
        if not candidate.is_absolute():
            candidate = app_dir / candidate
        if candidate.is_file():
            return candidate
        raise SystemExit(f"app.exe não encontrado: {candidate}")

    preferred = app_dir / DEFAULT_APP_EXE
    if preferred.is_file():
        return preferred

    for candidate in sorted(app_dir.glob("*.exe")):
        if candidate.name.lower() != LAUNCHER_NAME.lower():
            log.warning("app.exe predefinido ausente; a usar %s", candidate.name)
            return candidate
    raise SystemExit(f"nenhum executável da aplicação em {app_dir}")


def health_url(port: int) -> str:
    return f"http://{APP_HOST}:{port}{HEALTH_PATH}"


def instance_is_serving(port: int, timeout: float = 1.5) -> bool:
    """True se já existe uma Central a responder (outro utilizador/sessão)."""
    try:
        with urllib.request.urlopen(health_url(port), timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


class _JobObject:
    """Mata o app.exe quando o launcher termina, seja como for."""

    def __init__(self) -> None:
        self._handle = None
        self._job = None
        self._kernel32 = None
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        ]
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            log.warning("CreateJobObject falhou; sem garantia de limpeza do app.exe")
            return
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            log.warning("SetInformationJobObject falhou (erro %s)", ctypes.get_last_error())
        self._job = handle
        self._kernel32 = kernel32

    def assign(self, process: subprocess.Popen) -> None:
        handle = getattr(process, "_handle", None)
        if not self._job or handle is None:
            return
        try:
            if not self._kernel32.AssignProcessToJobObject(self._job, int(handle)):
                log.warning(
                    "AssignProcessToJobObject falhou (erro %s)", ctypes.get_last_error()
                )
        except (OSError, TypeError, ValueError) as exc:
            log.warning("não foi possível associar o app.exe ao job: %s", exc)


def acquire_single_instance() -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        return True
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        return False
    acquire_single_instance._handle = handle  # type: ignore[attr-defined]
    return True


# --------------------------------------------------------------------------
# processo: listar / terminar por caminho exato
# --------------------------------------------------------------------------
TH32CS_SNAPPROCESS = 0x00000002
MAX_PATH = 260
PROCESS_TERMINATE = 0x0001
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * MAX_PATH),
    ]


def _kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.GetLongPathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    return kernel32


def _canonical(path: str) -> str:
    """Forma comparável de um caminho (expande nomes 8.3 como ISAACF~1)."""
    kernel32 = _kernel32()
    size = kernel32.GetLongPathNameW(path, None, 0)
    if size:
        buffer = ctypes.create_unicode_buffer(size)
        if kernel32.GetLongPathNameW(path, buffer, size):
            path = buffer.value
    return os.path.normcase(os.path.abspath(path))


def _process_paths() -> list[tuple[int, str]]:
    kernel32 = _kernel32()
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        return []

    found: list[tuple[int, str]] = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return []
        while True:
            path = _image_path(kernel32, entry.th32ProcessID)
            if path:
                found.append((entry.th32ProcessID, path))
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def _image_path(kernel32, pid: int) -> str | None:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        size = wintypes.DWORD(MAX_PATH * 4)
        buffer = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return None
    finally:
        kernel32.CloseHandle(handle)


def terminate_by_paths(paths: set[str]) -> int:
    """Termina todos os processos cujo executável esteja em ``paths``."""
    kernel32 = _kernel32()
    wanted = {_canonical(p) for p in paths}
    wanted_names = {os.path.basename(p).lower() for p in paths}

    killed = 0
    for pid, path in _process_paths():
        if os.path.basename(path).lower() not in wanted_names:
            continue
        if _canonical(path) not in wanted:
            continue
        handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if handle:
            if kernel32.TerminateProcess(handle, 0):
                killed += 1
            kernel32.CloseHandle(handle)
    return killed


# --------------------------------------------------------------------------
# servidor do CRX / updates.xml
# --------------------------------------------------------------------------
CONTENT_TYPES = {
    ".xml": "text/xml; charset=utf-8",
    ".crx": "application/x-chrome-extension",
}


class _CrxHandler(http.server.BaseHTTPRequestHandler):
    server_version = "CentralRecepcionista"
    crx_dir: Path = Path(".")

    def do_GET(self) -> None:  # noqa: N802 (API do http.server)
        self._serve()

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(body=False)

    def do_POST(self) -> None:  # noqa: N802
        # O Chrome faz POST (Omaha) ao update_url, com o pedido no corpo.
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self._serve()

    def _serve(self, body: bool = True) -> None:
        name = self.path.split("?", 1)[0].rsplit("/", 1)[-1]
        if name != "updates.xml" and not name.endswith(".crx"):
            self.send_error(404, "Not Found")
            return

        target = self.crx_dir / name
        if not target.is_file():
            self.send_error(404, "Not Found")
            return

        content = target.read_bytes()
        self.send_response(200)
        self.send_header(
            "Content-Type", CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        )
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(content)

    def log_message(self, *args) -> None:  # silencia o access log
        return None

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, OSError):
            self.close_connection = True


def start_crx_server(crx_dir: Path, port: int) -> bool:
    if not crx_dir.is_dir():
        log.warning("pasta do CRX ausente (%s); a extensão não será servida", crx_dir)
        return False

    handler = type("_Handler", (_CrxHandler,), {"crx_dir": crx_dir})
    try:
        server = http.server.ThreadingHTTPServer((APP_HOST, port), handler)
    except OSError as exc:
        log.warning("não foi possível abrir %s:%s (%s)", APP_HOST, port, exc)
        return False

    thread = threading.Thread(target=server.serve_forever, name="crx-server", daemon=True)
    thread.start()
    log.info("a servir a extensão em http://%s:%s/updates.xml", APP_HOST, port)
    return True


# --------------------------------------------------------------------------
# modo --chrome-extension-help
# --------------------------------------------------------------------------
def find_chrome() -> Path | None:
    """Procura o chrome.exe nas localizações habituais e no registo."""
    for candidate in CHROME_CANDIDATES:
        path = Path(os.path.expandvars(candidate))
        if path.is_file():
            return path

    try:
        import winreg

        for hive, key in (
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
        ):
            try:
                with winreg.OpenKey(hive, key) as handle:
                    path = Path(winreg.QueryValue(handle, None))
                    if path.is_file():
                        return path
            except OSError:
                continue
    except ImportError:
        pass
    return None


def open_chrome_extension_help(app_dir: Path) -> int:
    ext_dir = app_dir / "extension"
    chrome = find_chrome()

    if chrome is not None:
        try:
            subprocess.Popen([str(chrome), "chrome://extensions"], close_fds=True)
        except OSError as exc:
            log.warning("não foi possível abrir o Chrome: %s", exc)
    else:
        log.warning("chrome.exe não encontrado; abra manualmente chrome://extensions")

    if ext_dir.is_dir():
        try:
            subprocess.Popen(["explorer.exe", str(ext_dir)], close_fds=True)
        except OSError as exc:
            log.warning("não foi possível abrir a pasta da extensão: %s", exc)
    return 0


# --------------------------------------------------------------------------
# modo --stop
# --------------------------------------------------------------------------
def stop_everything(app_dir: Path, launcher_path: Path) -> int:
    targets = {str(launcher_path)}
    try:
        targets.add(str(find_app_exe(app_dir, None)))
    except SystemExit:
        pass

    killed = terminate_by_paths(targets)
    log.info("--stop: %s processo(s) terminado(s)", killed)

    deadline = time.time() + 8
    while time.time() < deadline:
        if not terminate_by_paths(targets):
            break
        time.sleep(0.5)
    return 0


# --------------------------------------------------------------------------
# supervisão
# --------------------------------------------------------------------------
def supervise(app_exe: Path, app_dir: Path, crx_port: int, app_port: int, serve_crx: bool) -> int:
    if not acquire_single_instance():
        log.info("já existe um launcher nesta sessão; a sair")
        return 0

    if serve_crx:
        start_crx_server(app_dir / CRX_DIR_NAME, crx_port)

    job = _JobObject()
    backoff, max_backoff = 2, 60
    warned = False

    while True:
        # Se outra sessão/utilizador já serve a Central, esperamos a nossa vez
        # em vez de competir pela porta.
        while instance_is_serving(app_port):
            if not warned:
                log.info("outra instância já responde em :%s; a aguardar", app_port)
                warned = True
            time.sleep(5)
        if warned:
            log.info("a porta :%s ficou livre; a assumir", app_port)
            warned = False

        started = time.time()
        try:
            proc = subprocess.Popen(
                [str(app_exe)],
                cwd=str(app_dir),
                creationflags=CREATE_NO_WINDOW,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        except OSError as exc:
            log.error("não foi possível arrancar %s: %s", app_exe.name, exc)
            time.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)
            continue

        job.assign(proc)
        log.info("app.exe arrancado (pid %s)", proc.pid)

        proc.wait()
        log.warning("app.exe terminou com código %s", proc.returncode)

        if time.time() - started > 60:
            backoff = 2  # correu bem durante bastante tempo
        time.sleep(backoff)
        backoff = min(backoff * 2, max_backoff)


# --------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--chrome-extension-help", action="store_true")
    parser.add_argument("--app")
    parser.add_argument("--port", type=int, default=CRX_PORT)
    parser.add_argument(
        "--app-port",
        type=int,
        default=int(os.environ.get("CENTRAL_APP_PORT", DEFAULT_APP_PORT)),
    )
    parser.add_argument("--no-crx-server", action="store_true")
    args, _unknown = parser.parse_known_args(argv)

    app_dir = detect_app_dir()
    setup_logging(app_dir)
    launcher_path = detect_launcher_path()

    try:
        if args.stop:
            return stop_everything(app_dir, launcher_path)
        if args.chrome_extension_help:
            return open_chrome_extension_help(app_dir)
        app_exe = find_app_exe(app_dir, args.app)
    except SystemExit as exc:
        log.error("%s", exc)
        return 1

    log.info("launcher iniciado (app=%s, dir=%s)", app_exe.name, app_dir)
    return supervise(app_exe, app_dir, args.port, args.app_port, not args.no_crx_server)


if __name__ == "__main__":
    sys.exit(main())
