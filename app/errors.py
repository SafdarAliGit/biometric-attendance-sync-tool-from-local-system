"""Turn exceptions into a short readable message plus technical detail."""
import errno
import socket
import traceback

import requests

try:
    from zk.exception import ZKErrorConnection, ZKErrorResponse, ZKNetworkError
except Exception:  # pragma: no cover - pyzk missing
    class ZKErrorConnection(Exception):
        pass

    class ZKErrorResponse(Exception):
        pass

    class ZKNetworkError(Exception):
        pass


class TaskError(Exception):
    """An expected failure with a readable message."""

    def __init__(self, message: str, detail: str = "", retryable: bool = True):
        super().__init__(message)
        self.message = message
        self.detail = detail
        self.retryable = retryable


class Cancelled(Exception):
    pass


def explain(exc: BaseException, context: str = "") -> tuple[str, str, bool]:
    """Return (message, detail, retryable)."""
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
    prefix = f"{context}: " if context else ""
    text = str(exc)

    if isinstance(exc, TaskError):
        return prefix + exc.message, exc.detail or detail, exc.retryable
    if isinstance(exc, Cancelled):
        return "Cancelled by user", "", False
    if isinstance(exc, ZKNetworkError):
        return (prefix + "The machine did not answer on the network. Check that it is switched "
                "on, that the IP address is right and that this PC can reach it (ping). "
                f"({text})", detail, True)
    if isinstance(exc, ZKErrorResponse):
        if "unauth" in text.lower():
            return (prefix + "The machine refused the connection: the communication password "
                    "(comm key) is wrong. Set it under Machines → Edit.", detail, False)
        return prefix + f"The machine returned an error: {text}", detail, True
    if isinstance(exc, ZKErrorConnection):
        return (prefix + "The connection to the machine failed or was dropped. If this keeps "
                f"happening, try the 'Use UDP' option or a longer timeout. ({text})", detail, True)
    if isinstance(exc, requests.exceptions.SSLError):
        return (prefix + "The ERPNext SSL certificate could not be verified. Fix the certificate "
                "or turn off 'Verify SSL certificate' in Settings.", detail, True)
    if isinstance(exc, requests.exceptions.ConnectionError):
        return (prefix + "Could not reach ERPNext. Check the internet connection and the ERPNext "
                "URL.", detail, True)
    if isinstance(exc, requests.exceptions.Timeout):
        return prefix + "ERPNext did not respond in time.", detail, True
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return (prefix + "The connection timed out. The machine may be unreachable or busy.",
                detail, True)
    if isinstance(exc, socket.gaierror):
        return prefix + "The host name could not be resolved. Check the address.", detail, False
    if isinstance(exc, ConnectionRefusedError):
        return (prefix + "The connection was refused. Check the port number of the machine.",
                detail, True)
    if isinstance(exc, ConnectionResetError):
        return prefix + "The connection was reset by the machine or the network.", detail, True
    if isinstance(exc, OSError):
        if exc.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH):
            return (prefix + "No route to the machine. Check the network cable / Wi-Fi and the "
                    "IP address.", detail, True)
        if exc.errno == errno.ENOSPC:
            return prefix + "There is no space left on this PC's disk.", detail, False
        return prefix + f"System error: {exc}", detail, True
    return prefix + f"Unexpected error: {exc}", detail, True
