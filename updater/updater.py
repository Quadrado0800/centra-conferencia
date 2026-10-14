#!/usr/bin/env python3
"""Download and install signed Central do Recepcionista releases.

The updater is intentionally independent from the launcher: an installer can
replace the launcher only after this process has started it.  It uses GitHub
Release assets, verifies the SHA-256 digest, and keeps a private backup while
the new installation is health-checked.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_REPOSITORY = "Quadrado0800/centra-conferencia"
DEFAULT_ASSET = "CentralRecepcionista_Setup.exe"
DEFAULT_HEALTH_URL = "http://127.0.0.1:8000/api/session/status"
USER_AGENT = "CentralRecepcionistaUpdater/1"
BACKUP_DIR_NAME = ".update-backup"
BACKUP_FILES = (
    "Central_Recepcionist_conf_plus_printer.exe",
    "CentralRecepcionistaLauncher.exe",
    "CentralRecepcionistaUpdater.exe",
)
log = logging.getLogger("updater")


class UpdateError(RuntimeError):
    """A release could not be safely downloaded or installed."""


@dataclass(frozen=True)
class Release:
    tag: str
    version: str
    asset_url: str
    digest: str


def _request(url: str, timeout: float = 20.0) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, OSError) as exc:
        raise UpdateError(f"não foi possível aceder a {url}: {exc}") from exc


def _json(url: str) -> dict[str, Any]:
    try:
        value = json.loads(_request(url).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpdateError(f"resposta inválida de {url}") from exc
    if not isinstance(value, dict):
        raise UpdateError(f"resposta inesperada de {url}")
    return value


def latest_release(repository: str = DEFAULT_REPOSITORY, asset_name: str = DEFAULT_ASSET) -> Release:
    """Read the latest published release and locate its installer asset."""
    data = _json(f"https://api.github.com/repos/{repository}/releases/latest")
    tag = str(data.get("tag_name", "")).strip()
    if not tag:
        raise UpdateError("a release do GitHub não tem tag")

    assets = data.get("assets")
    if not isinstance(assets, list):
        raise UpdateError("a release do GitHub não tem assets")
    asset = next(
        (
            item
            for item in assets
            if isinstance(item, dict) and item.get("name") == asset_name
        ),
        None,
    )
    if not isinstance(asset, dict) or not isinstance(asset.get("browser_download_url"), str):
        raise UpdateError(f"asset {asset_name!r} não encontrado na release {tag}")

    digest = str(asset.get("digest", "")).removeprefix("sha256:").lower()
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise UpdateError(
            f"a release {tag} não publicou um digest SHA-256 para {asset_name}"
        )
    return Release(tag, tag.removeprefix("v"), asset["browser_download_url"], digest)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installed_version(install_dir: Path) -> str | None:
    version_file = install_dir / "version.txt"
    try:
        version = version_file.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return version or None


def version_key(version: str) -> tuple[int, ...]:
    """Return a comparable key for Chrome-style numeric release versions."""
    try:
        parts = tuple(int(part) for part in version.split("."))
    except ValueError as exc:
        raise UpdateError(f"versão inválida: {version!r}") from exc
    if not parts or any(part < 0 for part in parts):
        raise UpdateError(f"versão inválida: {version!r}")
    return parts


def download_release(release: Release, destination: Path) -> Path:
    """Download an installer and verify it before returning its path."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        temporary.write_bytes(_request(release.asset_url, timeout=120.0))
        actual = sha256(temporary)
        if actual != release.digest:
            raise UpdateError(
                f"digest inválido para {release.tag}: esperado {release.digest}, obtido {actual}"
            )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def _stop_launcher(install_dir: Path) -> None:
    launcher = install_dir / "CentralRecepcionistaLauncher.exe"
    if launcher.is_file():
        result = subprocess.run(
            [str(launcher), "--stop"],
            cwd=install_dir,
            check=False,
            creationflags=0x08000000,
            timeout=20,
        )
        if result.returncode != 0:
            raise UpdateError(f"o launcher recusou a paragem (código {result.returncode})")


def _wait_healthy(url: str, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=2.0) as response:
                if 200 <= response.status < 500:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(1)
    return False


def install_with_rollback(
    installer: Path,
    install_dir: Path,
    *,
    health_url: str = DEFAULT_HEALTH_URL,
) -> None:
    """Run an installer and restore launcher files if the new version is unhealthy."""
    backup_dir = install_dir / BACKUP_DIR_NAME
    backup_dir.mkdir(parents=True, exist_ok=True)
    saved: list[tuple[Path, Path]] = []
    try:
        _stop_launcher(install_dir)
        for name in BACKUP_FILES:
            source = install_dir / name
            if source.is_file():
                target = backup_dir / name
                shutil.copy2(source, target)
                saved.append((source, target))

        result = subprocess.run(
            [str(installer), "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
            check=False,
            creationflags=0x08000000,
            timeout=600,
        )
        if result.returncode != 0:
            raise UpdateError(f"o instalador terminou com código {result.returncode}")
        if not _wait_healthy(health_url):
            raise UpdateError("a aplicação não respondeu ao health check após a atualização")
        log.info("atualização instalada com sucesso")
    except (OSError, subprocess.SubprocessError) as exc:
        raise UpdateError(f"falha ao executar a atualização: {exc}") from exc
    except UpdateError:
        try:
            _stop_launcher(install_dir)
        except (OSError, subprocess.SubprocessError, UpdateError):
            log.exception("não foi possível parar a versão defeituosa antes do rollback")
        for source, target in saved:
            try:
                shutil.copy2(target, source)
            except OSError:
                log.exception("falha ao restaurar %s", source)
        raise
    finally:
        shutil.rmtree(backup_dir, ignore_errors=True)


def _run_one_shot_from_temp(argv: list[str]) -> int:
    """Run a temporary copy so the installed updater can be replaced safely."""
    if not getattr(sys, "frozen", False):
        return -1

    temporary_dir = Path(os.environ.get("TEMP", ".")) / f"CentralRecepcionistaUpdate-{os.getpid()}"
    temporary_dir.mkdir(parents=True, exist_ok=True)
    temporary_exe = temporary_dir / "updater.exe"
    shutil.copy2(Path(sys.executable), temporary_exe)
    worker_args = [str(temporary_exe), "--worker", *argv]
    worker_env = os.environ.copy()
    worker_env["CENTRAL_UPDATER_TEMP_DIR"] = str(temporary_dir)
    worker = subprocess.Popen(
        worker_args,
        cwd=temporary_dir,
        creationflags=0x08000000,
        close_fds=True,
        env=worker_env,
    )
    log.info("updater destacado para processo único (pid %s)", worker.pid)
    return 0


def _schedule_temp_cleanup() -> None:
    temporary_dir = os.environ.get("CENTRAL_UPDATER_TEMP_DIR")
    if not temporary_dir:
        return
    # The worker cannot remove its own executable on Windows. A short-lived
    # cmd process waits for this process to exit, then removes the directory.
    subprocess.Popen(
        [
            "cmd.exe",
            "/d",
            "/c",
            f'ping 127.0.0.1 -n 3 >nul & rmdir /s /q "{temporary_dir}"',
        ],
        creationflags=0x08000000,
        close_fds=True,
    )


def seconds_until_noon() -> float:
    now = datetime.now()
    next_noon = now.replace(hour=12, minute=0, second=0, microsecond=0)
    if now >= next_noon:
        next_noon += timedelta(days=1)
    return (next_noon - now).total_seconds()


def run_daemon() -> int:
    """Keep a lightweight process alive and check once at local noon."""
    stop_file = Path(sys.executable).resolve().parent / ".updater-stop"
    stop_file.unlink(missing_ok=True)
    log.info("updater iniciado; próxima verificação em %.0f segundos", seconds_until_noon())
    while True:
        remaining = seconds_until_noon()
        while remaining > 0:
            if stop_file.exists():
                stop_file.unlink(missing_ok=True)
                log.info("updater parado para manutenção")
                return 0
            delay = min(remaining, 1)
            time.sleep(delay)
            remaining -= delay
        detached = _run_one_shot_from_temp(
            [
                "--install-latest",
                "--install-dir",
                str(Path(sys.executable).resolve().parent),
            ]
        )
        if detached < 0:
            log.warning("updater em modo fonte: verificação ignorada")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("CENTRAL_UPDATE_REPOSITORY", DEFAULT_REPOSITORY))
    parser.add_argument("--asset", default=DEFAULT_ASSET)
    parser.add_argument("--check", action="store_true", help="mostra a última release disponível")
    parser.add_argument("--install-latest", action="store_true", help="instala apenas se a release for mais recente")
    parser.add_argument("--download", type=Path, help="baixa e verifica o instalador neste caminho")
    parser.add_argument("--install", type=Path, help="instalador previamente baixado")
    parser.add_argument("--install-dir", type=Path, default=Path.cwd())
    parser.add_argument("--health-url", default=DEFAULT_HEALTH_URL)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--daemon", action="store_true", help="aguarda a verificação diária ao meio-dia")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    if args.daemon and not args.worker:
        return run_daemon()
    if args.worker and args.install_latest:
        (args.install_dir / ".updater-stop").unlink(missing_ok=True)
    if not args.worker and (args.install_latest or args.install):
        detached = _run_one_shot_from_temp(argv or sys.argv[1:])
        if detached >= 0:
            return detached

    try:
        release = latest_release(args.repository, args.asset)
        if args.check:
            current = installed_version(args.install_dir)
            state = "atualizada" if current and version_key(release.version) <= version_key(current) else "disponível"
            print(f"{release.version} ({release.tag}) - {state}")
        if args.download:
            download_release(release, args.download)
            print(args.download)
        if args.install:
            install_with_rollback(args.install, args.install_dir, health_url=args.health_url)
        if args.install_latest:
            current = installed_version(args.install_dir)
            if current and version_key(release.version) <= version_key(current):
                log.info("nenhuma atualização disponível (instalada: %s)", current)
            else:
                download_path = args.install_dir / ".update-download" / args.asset
                download_release(release, download_path)
                install_with_rollback(download_path, args.install_dir, health_url=args.health_url)
            updater = args.install_dir / "CentralRecepcionistaUpdater.exe"
            if updater.is_file():
                subprocess.Popen(
                    [str(updater), "--daemon"],
                    cwd=args.install_dir,
                    creationflags=0x08000000,
                    close_fds=True,
                )
        if not (args.check or args.download or args.install or args.install_latest):
            parser.error("use --check, --download ou --install")
    except UpdateError as exc:
        log.error("%s", exc)
        _schedule_temp_cleanup()
        if args.worker and args.install_latest:
            updater = args.install_dir / "CentralRecepcionistaUpdater.exe"
            if updater.is_file():
                subprocess.Popen(
                    [str(updater), "--daemon"],
                    cwd=args.install_dir,
                    creationflags=0x08000000,
                    close_fds=True,
                )
        return 1
    _schedule_temp_cleanup()
    return 0


if __name__ == "__main__":
    sys.exit(main())
