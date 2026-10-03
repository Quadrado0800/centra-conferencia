#!/usr/bin/env python3
"""Prepara a extensao Chrome ("Central do recepcionista") para distribuicao.

Passos:
  1. Garante uma chave RSA estavel em ``keys/central_recepcao.pem``. A chave
     define o ID da extensao, e esse ID e gravado na politica do Chrome pelo
     instalador -- por isso tem de ser sempre a mesma.
  2. Copia a extensao para ``generated/extension`` e injeta o campo ``key``
     no ``manifest.json``, para que "Carregar sem compactacao" produza
     exatamente o mesmo ID do CRX.
  3. Empacota essa pasta num CRX3 (``generated/central_recepcao.crx``).
  4. Gera ``generated/updates.xml`` (manifesto de atualizacao Omaha, servido
     pelo launcher) e ``generated/build_vars.iss`` (variaveis consumidas pelo
     CentralRecepcionista.iss).

Uso:
    python installer/build_extension.py
    python installer/build_extension.py --cross-check-chrome
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

INSTALLER_DIR = Path(__file__).resolve().parent
REPO_ROOT = INSTALLER_DIR.parent
EXT_SRC = REPO_ROOT / "CRM-LIKE_conference" / "desbravador-conferencia"
KEY_FILE = INSTALLER_DIR / "keys" / "central_recepcao.pem"
GENERATED = INSTALLER_DIR / "generated"

CRX_NAME = "central_recepcao.crx"
CRX_PORT = 8011
CRX_MAGIC = b"Cr24"
CRX_VERSION = 3
SIGNATURE_CONTEXT = b"CRX3 SignedData\x00"
CHROME_EXE_CANDIDATES = (
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
)
# Zips deterministicos (mesma entrada => mesmo CRX).
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


# --------------------------------------------------------------------------
# protobuf minimo (só o necessário para o cabeçalho do CRX3)
# --------------------------------------------------------------------------
def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        chunk = value & 0x7F
        value >>= 7
        out.append(chunk | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _bytes_field(field: int, data: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(data)) + data


def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def _iter_fields(buf: bytes):
    """Percorre um message protobuf e devolve (field_number, value_bytes)."""
    pos = 0
    while pos < len(buf):
        key, pos = _read_varint(buf, pos)
        field, wire = key >> 3, key & 0x07
        if wire == 2:
            length, pos = _read_varint(buf, pos)
            yield field, buf[pos : pos + length]
            pos += length
        elif wire == 0:
            _, pos = _read_varint(buf, pos)
            yield field, b""
        else:  # o Chrome não usa outros wire types neste cabeçalho
            raise ValueError(f"wire type inesperado: {wire}")


# --------------------------------------------------------------------------
# chave / ID da extensão
# --------------------------------------------------------------------------
def load_or_create_key() -> rsa.RSAPrivateKey:
    if KEY_FILE.exists():
        key = serialization.load_pem_private_key(KEY_FILE.read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey):
            raise SystemExit(f"{KEY_FILE} não contém uma chave RSA.")
        return key

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    # PKCS#8: e o unico formato que o `chrome --pack-extension-key` aceita.
    KEY_FILE.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    print(f"[key] nova chave criada: {KEY_FILE}")
    return key


def public_key_der(key: rsa.RSAPrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def extension_id(pub_der: bytes) -> str:
    """ID do Chrome = primeiros 16 bytes do SHA-256 da chave, em a..p."""
    digest = hashlib.sha256(pub_der).digest()[:16]
    return "".join(
        chr(ord("a") + (byte >> 4)) + chr(ord("a") + (byte & 0x0F)) for byte in digest
    )


# --------------------------------------------------------------------------
# CRX3
# --------------------------------------------------------------------------
def pack_crx3(zip_bytes: bytes, key: rsa.RSAPrivateKey) -> bytes:
    pub_der = public_key_der(key)
    signed_header_data = _bytes_field(1, hashlib.sha256(pub_der).digest()[:16])

    payload = (
        SIGNATURE_CONTEXT
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + zip_bytes
    )
    signature = key.sign(payload, padding.PKCS1v15(), hashes.SHA256())

    proof = _bytes_field(1, pub_der) + _bytes_field(2, signature)
    header = _bytes_field(2, proof) + _bytes_field(10000, signed_header_data)

    return (
        CRX_MAGIC
        + struct.pack("<I", CRX_VERSION)
        + struct.pack("<I", len(header))
        + header
        + zip_bytes
    )


def parse_crx3(crx_bytes: bytes) -> tuple[bytes, bytes, bytes, bytes]:
    """Devolve (public_key, signature, signed_header_data, zip_archive)."""
    if crx_bytes[:4] != CRX_MAGIC:
        raise ValueError("assinatura de ficheiro CRX inválida (falta 'Cr24').")
    version, header_len = struct.unpack("<II", crx_bytes[4:12])
    if version != 3:
        raise ValueError(f"versão CRX não suportada: {version}")

    header = crx_bytes[12 : 12 + header_len]
    archive = crx_bytes[12 + header_len :]

    pub_der = signature = signed_header_data = b""
    for field, value in _iter_fields(header):
        if field == 2 and not pub_der:  # sha256_with_rsa[0]
            for sub_field, sub_value in _iter_fields(value):
                if sub_field == 1:
                    pub_der = sub_value
                elif sub_field == 2:
                    signature = sub_value
        elif field == 10000:
            signed_header_data = value
    if not pub_der or not signature:
        raise ValueError("cabeçalho do CRX sem chave/assinatura RSA.")
    return pub_der, signature, signed_header_data, archive


def verify_crx3(crx_bytes: bytes) -> bytes:
    """Confere a assinatura do CRX3. Devolve a chave pública (DER)."""
    pub_der, signature, signed_header_data, archive = parse_crx3(crx_bytes)
    payload = (
        SIGNATURE_CONTEXT
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + archive
    )
    serialization.load_der_public_key(pub_der).verify(
        signature, payload, padding.PKCS1v15(), hashes.SHA256()
    )
    return pub_der


# --------------------------------------------------------------------------
# extensão
# --------------------------------------------------------------------------
def stage_extension(key: rsa.RSAPrivateKey) -> Path:
    """Copia a extensão para generated/extension e injeta o campo "key"."""
    if not (EXT_SRC / "manifest.json").is_file():
        raise SystemExit(f"manifest.json não encontrado em {EXT_SRC}")

    dest = GENERATED / "extension"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(
        EXT_SRC,
        dest,
        ignore=shutil.ignore_patterns("*.pem", "*.crx", "*.zip", "*.bak"),
    )

    manifest_path = dest / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["key"] = base64.b64encode(public_key_der(key)).decode("ascii")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return dest


def zip_extension(ext_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(ext_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() in {".pem", ".crx"}:
                continue
            info = zipfile.ZipInfo(path.relative_to(ext_dir).as_posix(), ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())
    return buffer.getvalue()


def updates_xml(ext_id: str, version: str) -> str:
    codebase = f"http://127.0.0.1:{CRX_PORT}/{CRX_NAME}"
    return (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        f"  <app appid='{ext_id}'>\n"
        f"    <updatecheck codebase='{codebase}' version='{version}' />\n"
        "  </app>\n"
        "</gupdate>\n"
    )


def build_vars_iss(ext_id: str, version: str) -> str:
    return (
        "; GERADO por installer/build_extension.py -- nao editar a mao.\n"
        f'#define ExtId "{ext_id}"\n'
        f'#define ExtVersion "{version}"\n'
        f'#define ExtUpdateUrl "http://127.0.0.1:{CRX_PORT}/updates.xml"\n'
        f'#define ExtCrxFile "{CRX_NAME}"\n'
    )


# --------------------------------------------------------------------------
# verificação cruzada com o empacotador do próprio Chrome
# --------------------------------------------------------------------------
def find_chrome() -> Path | None:
    for candidate in CHROME_EXE_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def cross_check_with_chrome(ext_dir: Path, key: rsa.RSAPrivateKey) -> bool:
    """Empacota com o Chrome e confirma que a nossa leitura bate certo.

    Prova duas coisas: que a nossa verificação do CRX3 interpreta o mesmo
    layout de dados assinados que o Chrome, e que calculamos o mesmo ID.
    """
    chrome = find_chrome()
    if chrome is None:
        print("[cross-check] Chrome não encontrado -- verificação ignorada.")
        return True

    with tempfile.TemporaryDirectory(prefix="crxcheck-") as tmp:
        work = Path(tmp) / "extension"
        shutil.copytree(ext_dir, work)
        result = subprocess.run(
            [
                str(chrome),
                f"--user-data-dir={Path(tmp) / 'profile'}",
                "--no-first-run",
                "--no-default-browser-check",
                "--pack-extension=" + str(work),
                "--pack-extension-key=" + str(KEY_FILE),
            ],
            capture_output=True,
            timeout=180,
        )
        chrome_crx = work.with_suffix(".crx")
        if not chrome_crx.is_file():
            print("[cross-check] o Chrome não produziu CRX:")
            print((result.stdout or b"").decode(errors="replace")[-800:])
            print((result.stderr or b"").decode(errors="replace")[-800:])
            return False

        try:
            chrome_pub = verify_crx3(chrome_crx.read_bytes())
        except Exception as exc:  # assinatura/padrão que não percebemos
            print(f"[cross-check] FALHOU a verificar o CRX do Chrome: {exc}")
            return False

    expected = extension_id(public_key_der(key))
    if chrome_pub != public_key_der(key):
        print("[cross-check] FALHOU: o CRX do Chrome usa outra chave pública.")
        return False
    if extension_id(chrome_pub) != expected:
        print("[cross-check] FALHOU: ID calculado difere do ID do Chrome.")
        return False

    print(f"[cross-check] OK -- layout CRX3 e ID confirmados (id={expected})")
    return True


# --------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="Prepara a extensão para o instalador.")
    parser.add_argument(
        "--cross-check-chrome",
        action="store_true",
        help="empacota também com o Chrome e compara o resultado com o nosso",
    )
    args = parser.parse_args()

    GENERATED.mkdir(parents=True, exist_ok=True)
    key = load_or_create_key()
    ext_id = extension_id(public_key_der(key))

    ext_dir = stage_extension(key)
    manifest = json.loads((ext_dir / "manifest.json").read_text(encoding="utf-8"))
    version = str(manifest.get("version", "0"))
    name = str(manifest.get("name", "extensao"))

    crx_bytes = pack_crx3(zip_extension(ext_dir), key)
    verify_crx3(crx_bytes)  # nunca escrever um CRX que não verificamos

    (GENERATED / CRX_NAME).write_bytes(crx_bytes)
    (GENERATED / "updates.xml").write_text(updates_xml(ext_id, version), encoding="utf-8")
    (GENERATED / "build_vars.iss").write_text(build_vars_iss(ext_id, version), encoding="utf-8")
    (GENERATED / "extension_id.txt").write_text(ext_id + "\n", encoding="utf-8")

    print(f"[ext] {name} v{version}")
    print(f"[ext] id    : {ext_id}")
    print(f"[ext] crx   : {GENERATED / CRX_NAME} ({len(crx_bytes)} bytes)")
    print(f"[ext] pasta : {ext_dir}")

    if args.cross_check_chrome and not cross_check_with_chrome(ext_dir, key):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
