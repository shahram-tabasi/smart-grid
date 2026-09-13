#!/usr/bin/env python3
"""
Standalone Modbus TCP probe for commissioning a relay.

Deliberately dependency-free (standard library only, no pymodbus) so it can be run on a
commissioning laptop with nothing installed, and standalone so it answers one question without the
platform in the way: does this relay actually speak Modbus TCP, and on which unit id and register
table does it answer?

That distinction matters, because a relay whose port is open is not a relay that serves Modbus.
`Test-NetConnection` (or any port check) proves only that something accepted a TCP connection.

Usage:
    python modbus-probe.py 192.168.20.64
    python modbus-probe.py 192.168.20.64 --port 502 --unit 1
    python modbus-probe.py 192.168.20.64 --unit-scan
    python modbus-probe.py 192.168.20.64 --address 30001 --count 4

Exit code is 0 when the relay answered at least one read, 1 otherwise.
"""

import argparse
import socket
import struct
import sys
import time

FUNCTIONS = {
    1: "Read Coils",
    2: "Read Discrete Inputs",
    3: "Read Holding Registers",
    4: "Read Input Registers",
}

# Modbus exception codes, so a rejection reads as a diagnosis rather than a number.
EXCEPTIONS = {
    1: "ILLEGAL FUNCTION - the relay does not support this function code",
    2: "ILLEGAL DATA ADDRESS - the register does not exist on this relay (wrong address or table)",
    3: "ILLEGAL DATA VALUE - the quantity requested is out of range",
    4: "SLAVE DEVICE FAILURE - the relay hit an internal error serving this read",
    6: "SLAVE DEVICE BUSY - the relay is busy; retry later",
    11: "GATEWAY TARGET DEVICE FAILED TO RESPOND - wrong unit id behind a Modbus gateway",
}


class Dropped(Exception):
    """The peer closed the connection instead of answering."""


def wire_address(documentation_address: int) -> tuple[int, int]:
    """
    Translate a documentation-style address to (function code, zero-based wire address).

    Modbus documentation numbers registers 3xxxx / 4xxxx / 1xxxx by table, one-based, while the
    wire protocol carries a zero-based offset within a table selected by the function code. Relay
    manuals almost always print the documentation form, so accept that and convert.
    """
    a = documentation_address
    if a >= 40001:
        return 3, a - 40001
    if a >= 30001:
        return 4, a - 30001
    if a >= 10001:
        return 2, a - 10001
    return 3, a


def read_once(sock: socket.socket, unit: int, function: int, address: int, count: int, tid: int) -> bytes:
    """Send one read and return the response PDU (function code + payload). Raises on a drop."""
    pdu = struct.pack(">BHH", function, address, count)
    mbap = struct.pack(">HHHB", tid, 0, len(pdu) + 1, unit)
    sock.sendall(mbap + pdu)

    header = recv_exactly(sock, 7)
    length = struct.unpack(">H", header[4:6])[0]
    return recv_exactly(sock, length - 1)


def recv_exactly(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise Dropped("peer closed the connection mid-response")
        buf += chunk
    return buf


def describe(response: bytes, count: int) -> str:
    function = response[0]
    if function & 0x80:
        code = response[1] if len(response) > 1 else 0
        return f"EXCEPTION 0x{code:02x} - {EXCEPTIONS.get(code, 'unknown exception code')}"

    payload = response[2:]
    if function in (1, 2):
        bits = [(payload[0] >> i) & 1 for i in range(min(count, 8))] if payload else []
        return f"bits={bits}"

    words = [struct.unpack(">H", payload[i : i + 2])[0] for i in range(0, len(payload) - 1, 2)]
    out = [f"raw16={words}"]
    if len(words) >= 2:
        u32 = (words[0] << 16) | words[1]
        f32 = struct.unpack(">f", struct.pack(">HH", words[0], words[1]))[0]
        out.append(f"as_uint32={u32}")
        out.append(f"as_float32={f32:.4f}")
    return "  ".join(out)


def probe(host: str, port: int, unit: int, address: int, count: int, hold: float) -> str:
    """Returns 'data', 'exception' (relay spoke Modbus but refused the read) or 'none'."""
    function, wire = wire_address(address)
    print(f"\n--- unit id {unit} ---")
    print(f"connecting to {host}:{port} ...", flush=True)

    started = time.monotonic()
    try:
        sock = socket.create_connection((host, port), timeout=10)
    except OSError as err:
        print(f"  CONNECT FAILED: {err}")
        print("  -> The relay is not reachable at all. Check IP, VLAN, routing and firewall.")
        return "none"

    connected_after = time.monotonic() - started
    print(f"  connected in {connected_after * 1000:.0f} ms")
    sock.settimeout(10)

    answered = "none"
    try:
        print(f"  reading {FUNCTIONS[function]} (fc={function}) at documentation address {address}")
        print(f"    -> wire address {wire}, quantity {count}, unit id {unit}")
        response = read_once(sock, unit, function, wire, count, tid=1)
        print(f"    RESPONSE: {describe(response, count)}")
        # An exception response is still Modbus: the relay parsed the request and refused it. That
        # is a different problem from silence, and points at the address rather than the link.
        answered = "exception" if response[0] & 0x80 else "data"
    except (Dropped, ConnectionResetError) as err:
        # A relay refusing the session shows up either as a clean FIN or as an RST, depending on the
        # device and on whatever sits in the path. Both mean the same thing here.
        print(f"    DROPPED: {err}")
        print("    -> The relay accepted TCP but closed it instead of answering Modbus.")
        print("       Typical causes: Modbus TCP not enabled on the relay, or this client's IP is")
        print("       not in the relay's allowed-masters list, or a firewall is cutting the session.")
    except socket.timeout:
        print("    TIMEOUT: connection stayed open but the relay never answered.")
        print("    -> Something is listening on 502, but it is not answering Modbus on this unit id.")
    except OSError as err:
        print(f"    ERROR: {err}")

    if hold > 0:
        # The platform's poll interval means the first read can be seconds after connecting. If an
        # idle socket is being cut, that is what kills it, so measure how long idle survives.
        print(f"  holding the connection idle for {hold:.0f}s to see whether it survives ...")
        sock.settimeout(hold + 1)
        idle_started = time.monotonic()
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            data = sock.recv(1)
            idle_for = time.monotonic() - idle_started
            if not data:
                print(f"    IDLE DROP: the relay closed the connection after {idle_for:.1f}s idle.")
                print("    -> Set the poll interval BELOW this, or the connection dies between polls.")
        except socket.timeout:
            print(f"    idle connection survived {hold:.0f}s - an idle timeout is not the problem.")
        except OSError as err:
            print(f"    idle wait ended: {err}")

    sock.close()
    return answered


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe a relay's Modbus TCP server.")
    parser.add_argument("host")
    parser.add_argument("--port", type=int, default=502)
    parser.add_argument("--unit", type=int, default=1, help="Modbus unit/slave id (default 1)")
    parser.add_argument(
        "--unit-scan",
        action="store_true",
        help="Try unit ids 0-4 plus 255; relays vary and a wrong id looks like silence",
    )
    parser.add_argument(
        "--address",
        type=int,
        default=40001,
        help="Documentation-style address, e.g. 40001 holding, 30001 input (default 40001)",
    )
    parser.add_argument("--count", type=int, default=2, help="Registers to read (default 2)")
    parser.add_argument(
        "--hold",
        type=float,
        default=15.0,
        help="Seconds to hold the socket idle afterwards, to detect an idle cutoff (0 disables)",
    )
    args = parser.parse_args()

    units = [0, 1, 2, 3, 4, 255] if args.unit_scan else [args.unit]
    print(f"Modbus TCP probe -> {args.host}:{args.port}")

    results = []
    for unit in units:
        # Only measure the idle behaviour once; it is slow and identical across unit ids.
        hold = args.hold if unit == units[0] else 0
        results.append((unit, probe(args.host, args.port, unit, args.address, args.count, hold)))

    with_data = [u for u, r in results if r == "data"]
    with_exception = [u for u, r in results if r == "exception"]
    any_answer = bool(with_data or with_exception)

    print("\n================ VERDICT ================")
    if with_data:
        print(f"The relay SPEAKS Modbus TCP and returned register data on unit id {with_data[0]}.")
        print("If the platform still shows no data, the gap is in the point map or the")
        print("gateway configuration, not the relay or the network.")
    elif with_exception:
        print(f"The relay SPEAKS Modbus TCP (it answered on unit id {with_exception[0]}) but")
        print("refused this particular read - see the exception above.")
        print("The link and the unit id are fine; the ADDRESS is wrong. Take the correct register")
        print("addresses from the relay manual and put them in the point-map profile.")
    else:
        print("The relay did NOT return any Modbus data.")
        print("The port being open is not enough: nothing answered a valid read.")
        print("Check on the relay itself: is Modbus TCP enabled, which unit id is configured,")
        print("and is there an allowed-masters / client IP list this machine must be added to?")
    return 0 if any_answer else 1


if __name__ == "__main__":
    sys.exit(main())
