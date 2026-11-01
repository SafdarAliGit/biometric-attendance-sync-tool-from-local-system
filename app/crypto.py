"""Encryption of stored credentials and password hashing."""
import base64
import hashlib
import hmac
import os
import secrets

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .config import KEY_PATH, ensure_dirs

_fernet = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        ensure_dirs()
        if not KEY_PATH.exists():
            KEY_PATH.write_bytes(Fernet.generate_key())
            try:
                os.chmod(KEY_PATH, 0o600)
            except OSError:
                pass
        _fernet = Fernet(KEY_PATH.read_bytes().strip())
    return _fernet


def encrypt(value: str | None) -> str | None:
    if not value:
        return None
    return _get_fernet().encrypt(value.encode()).decode()


def decrypt(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return _get_fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return None


# ---- passphrase based encryption (config export / import between PCs) ----

def _derive(passphrase: str, salt: bytes) -> Fernet:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=390_000)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(passphrase.encode())))


def encrypt_with_passphrase(value: str, passphrase: str) -> str:
    salt = os.urandom(16)
    token = _derive(passphrase, salt).encrypt(value.encode())
    return base64.b64encode(salt).decode() + ":" + token.decode()


def decrypt_with_passphrase(blob: str, passphrase: str) -> str:
    salt_b64, token = blob.split(":", 1)
    return _derive(passphrase, base64.b64decode(salt_b64)).decrypt(token.encode()).decode()


# ---- admin password hashing ----

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260_000).hex()
    return f"pbkdf2${salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 260_000).hex()
    return hmac.compare_digest(check, digest)
