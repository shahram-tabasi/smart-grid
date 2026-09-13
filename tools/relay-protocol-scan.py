#!/usr/bin/env python3
"""
Find out which protocol a relay actually serves.

An open port is not a served protocol: a relay can accept TCP on 502 and reset the session the
moment a Modbus request arrives, which is what "the port is open but no data ever arrives" usually
turns out to mean. So this does not port-scan -- for the protocols where a handshake is cheap and
unambiguous it performs the real one, and reports only what genuinely answered.

Handshakes performed:
  IEC 61850 MMS (102)  - ISO-on-TCP: TPKT + COTP connection request, expects a connection confirm.
  IEC 60870-5-104 (2404) - APCI STARTDT_ACT, expects STARTDT_CON.
  Modbus TCP (502)     - Read Holding Registers, expects a response or a Modbus exception.
  DNP3 (20000)         - TCP only; a DNP3 outstation says nothing until spoken to in its own
                         framing, so silence here is not evidence either way.

Nothing this script sends can change a setting: every exchange is a connect or a read.

Usage:
    python relay-protocol-scan.py 192.168.20.64
"""

import socket
import struct
import sys

TIMEOUT = 6.0


def tcp_connect(host: str, port: int):
    try:
        sock = socket.create_connection((host, port), timeout=TIMEOUT)
        sock.settimeout(TIMEOUT)
        return sock, None
    except OSError as err:
        return None, str(err)


def try_iec61850(host: str) -> tuple[str, str]:
    """ISO-on-TCP (RFC 1006) connection request. A confirm means an MMS stack is listening."""
    sock, err = tcp_connect(host, 102)
    if not sock:
        return "closed", err or ""
    try:
        # COTP connection request: CR TPDU, source/destination references, TSAP parameters.
        cotp = bytes([
            0x11, 0xE0, 0x00, 0x00, 0x00, 0x01, 0x00,
            0xC1, 0x02, 0x00, 0x01,   # calling TSAP
            0xC2, 0x02, 0x00, 0x01,   # called TSAP
            0xC0, 0x01, 0x0A,         # TPDU size
        ])
        tpkt = bytes([0x03, 0x00]) + struct.pack(">H", len(cotp) + 4) + cotp
        sock.sendall(tpkt)
        reply = sock.recv(256)
        if not reply:
            return "reset", "accepted the connection then closed it without answering"
        # TPKT header is 4 bytes; COTP TPDU type is the second byte after it. 0xD0 = connect confirm.
        if len(reply) >= 6 and reply[0] == 0x03 and reply[5] == 0xD0:
            return "SPEAKS", "COTP connection confirmed - an IEC 61850 MMS stack answered"
        return "unclear", f"answered {len(reply)} bytes but not a COTP confirm: {reply[:12].hex()}"
    except (ConnectionResetError, BrokenPipeError) as err:
        return "reset", f"connection reset when spoken to ({err})"
    except socket.timeout:
        return "silent", "port open, but no answer to an ISO-on-TCP connection request"
    except OSError as err:
        return "error", str(err)
    finally:
        sock.close()


def try_iec104(host: str) -> tuple[str, str]:
    """APCI STARTDT activation. A STARTDT confirm is proof of a real IEC 104 slave."""
    sock, err = tcp_connect(host, 2404)
    if not sock:
        return "closed", err or ""
    try:
        sock.sendall(bytes([0x68, 0x04, 0x07, 0x00, 0x00, 0x00]))  # STARTDT_ACT
        reply = sock.recv(64)
        if not reply:
            return "reset", "accepted the connection then closed it without answering"
        if len(reply) >= 3 and reply[0] == 0x68 and reply[2] == 0x0B:
            return "SPEAKS", "STARTDT confirmed - an IEC 60870-5-104 slave answered"
        if len(reply) >= 1 and reply[0] == 0x68:
            return "SPEAKS", f"IEC 104 framing answered ({reply[:6].hex()})"
        return "unclear", f"answered but not IEC 104 framing: {reply[:12].hex()}"
    except (ConnectionResetError, BrokenPipeError) as err:
        return "reset", f"connection reset when spoken to ({err})"
    except socket.timeout:
        return "silent", "port open, but no answer to STARTDT"
    except OSError as err:
        return "error", str(err)
    finally:
        sock.close()


def try_modbus(host: str) -> tuple[str, str]:
    """Read Holding Registers. An exception response still proves a Modbus server is there."""
    sock, err = tcp_connect(host, 502)
    if not sock:
        return "closed", err or ""
    try:
        pdu = struct.pack(">BHH", 3, 0, 2)
        sock.sendall(struct.pack(">HHHB", 1, 0, len(pdu) + 1, 1) + pdu)
        reply = sock.recv(256)
        if not reply:
            return "reset", "accepted the connection then closed it without answering"
        if len(reply) >= 8 and reply[2:4] == b"\x00\x00":
            fc = reply[7]
            if fc & 0x80:
                return "SPEAKS", f"answered with a Modbus exception (0x{reply[8]:02x}) - server present"
            return "SPEAKS", "answered a register read - Modbus server present"
        return "unclear", f"answered but not Modbus framing: {reply[:12].hex()}"
    except (ConnectionResetError, BrokenPipeError) as err:
        return "reset", f"connection reset when spoken to ({err})"
    except socket.timeout:
        return "silent", "port open, but no answer to a register read"
    except OSError as err:
        return "error", str(err)
    finally:
        sock.close()


def try_tcp_only(host: str, port: int, label: str) -> tuple[str, str]:
    sock, err = tcp_connect(host, port)
    if not sock:
        return "closed", err or ""
    sock.close()
    return "open", f"{label}: TCP accepted (not probed further)"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: relay-protocol-scan.py <relay-ip>")
        return 2
    host = sys.argv[1]
    print(f"Protocol scan -> {host}\n")

    results = []

    for label, port, fn in (
        ("IEC 61850 MMS", 102, try_iec61850),
        ("IEC 60870-5-104", 2404, try_iec104),
        ("Modbus TCP", 502, try_modbus),
    ):
        status, detail = fn(host)
        results.append((label, port, status, detail))
        mark = "OK  " if status == "SPEAKS" else "--  "
        print(f"{mark}{label:<18} port {port:<6} {status.upper():<8} {detail}")

    for label, port in (("DNP3", 20000), ("SEL / telnet", 23), ("Web UI", 80), ("Web UI (TLS)", 443)):
        status, detail = try_tcp_only(host, port, label)
        results.append((label, port, status, detail))
        print(f"--  {label:<18} port {port:<6} {status.upper():<8} {detail}")

    speaking = [(l, p) for l, p, s, _ in results if s == "SPEAKS"]

    print("\n================ VERDICT ================")
    if speaking:
        print("This relay genuinely serves:")
        for label, port in speaking:
            print(f"  * {label} (port {port})")
        print("\nConfigure the relay's communication path in the platform with one of these")
        print("protocols. A protocol that answered here will carry data; one that only has an")
        print("open port will not.")
    else:
        print("No protocol answered a handshake on this address.")
        print("Ports may be open, but nothing behind them completed a protocol exchange.")
        print("On the relay, check which communication protocol is actually enabled and")
        print("mapped (on SIPROTEC 5 this is configured per ethernet channel in DIGSI 5).")
    return 0 if speaking else 1


if __name__ == "__main__":
    sys.exit(main())
