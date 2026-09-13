import * as net from 'net';

/**
 * IEC 60870-5-104 relay simulator.
 *
 * Pretends to be a protection relay on the network so the whole pipeline — gateway driver, ingest,
 * database, dashboard — can be exercised with no hardware at all. Point a registered relay at this
 * and run the gateway with SIMULATE=false: everything downstream is then running for real, driven
 * by genuine protocol frames.
 *
 * This is worth more than the gateway's own SIMULATE flag. That flag bypasses the protocol driver
 * entirely and fabricates events; this exercises the actual IEC 104 codec, so a framing or decoding
 * bug shows up here rather than on site.
 *
 * It implements the MONITOR direction of a slave: APCI framing, STARTDT/STOPDT/TESTFR, station
 * interrogation, cyclic measurements, and on demand a full protection trip sequence with
 * CP56Time2a timestamps.
 *
 * Run it with:  npm run simulator --workspace=@simorgh/edge-gateway
 */

const START = 0x68;

// Monitor-direction type ids used here (see protocols/iec60870/asdu.ts for the full set).
const M_SP_TB_1 = 30; // single point with CP56Time2a
const M_DP_TB_1 = 31; // double point with CP56Time2a
const M_ME_NC_1 = 13; // short float measurement
const C_IC_NA_1 = 100; // interrogation

const COT_PERIODIC = 1;
const COT_SPONTANEOUS = 3;
const COT_ACTIVATION_CON = 7;
const COT_ACTIVATION_TERM = 10;
const COT_INTERROGATED = 20;

export interface SimulatorOptions {
  port?: number;
  commonAddress?: number;
  /** Seconds between cyclic measurement updates. */
  measurementIntervalSec?: number;
  /** Emit a trip sequence automatically every N seconds. 0 disables it. */
  autoTripEverySec?: number;
  log?: (msg: string) => void;
}

/** Encode CP56Time2a — 7 bytes, millisecond resolution. */
function encodeCP56Time2a(d: Date): Buffer {
  const b = Buffer.alloc(7);
  b.writeUInt16LE(d.getUTCSeconds() * 1000 + d.getUTCMilliseconds(), 0);
  b[2] = d.getUTCMinutes() & 0x3f;
  b[3] = d.getUTCHours() & 0x1f;
  // Day of month in the low 5 bits; day of week in the top 3.
  b[4] = (d.getUTCDate() & 0x1f) | ((((d.getUTCDay() === 0 ? 7 : d.getUTCDay()) & 0x07) << 5));
  b[5] = (d.getUTCMonth() + 1) & 0x0f;
  b[6] = d.getUTCFullYear() % 100 & 0x7f;
  return b;
}

interface Client {
  socket: net.Socket;
  vs: number; // our send sequence number
  vr: number; // our receive sequence number
  started: boolean;
  rx: Buffer;
}

export class Iec104RelaySimulator {
  private server?: net.Server;
  private clients = new Set<Client>();
  private timers: NodeJS.Timeout[] = [];
  private readonly port: number;
  private readonly ca: number;
  private readonly log: (m: string) => void;

  /** Present state of the simulated relay. */
  private state = {
    current_A: 412.5,
    voltage_kV: 20.1,
    frequency_Hz: 50.01,
    breakerClosed: true,
  };

  constructor(private opts: SimulatorOptions = {}) {
    this.port = opts.port ?? 2404;
    this.ca = opts.commonAddress ?? 1;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.onConnection(socket));
      this.server.on('error', reject);
      this.server.listen(this.port, () => {
        this.log(`[simulator] IEC 60870-5-104 relay listening on port ${this.port} (common address ${this.ca})`);
        this.log('[simulator] point a registered relay at this host:port, then run the gateway with SIMULATE=false');

        const measInt = (this.opts.measurementIntervalSec ?? 10) * 1000;
        this.timers.push(setInterval(() => this.sendMeasurements(COT_PERIODIC), measInt));

        const tripEvery = this.opts.autoTripEverySec ?? 0;
        if (tripEvery > 0) {
          this.timers.push(setInterval(() => this.injectTrip(), tripEvery * 1000));
          this.log(`[simulator] will inject a protection trip every ${tripEvery}s`);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.clients.forEach((c) => c.socket.destroy());
    this.clients.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private onConnection(socket: net.Socket) {
    const client: Client = { socket, vs: 0, vr: 0, started: false, rx: Buffer.alloc(0) };
    this.clients.add(client);
    this.log(`[simulator] client connected from ${socket.remoteAddress}`);

    socket.on('data', (chunk) => this.onData(client, chunk));
    socket.on('close', () => {
      this.clients.delete(client);
      this.log('[simulator] client disconnected');
    });
    socket.on('error', () => {
      this.clients.delete(client);
    });
  }

  private onData(client: Client, chunk: Buffer) {
    client.rx = Buffer.concat([client.rx, chunk]);
    while (client.rx.length >= 2) {
      if (client.rx[0] !== START) {
        const i = client.rx.indexOf(START);
        client.rx = i < 0 ? Buffer.alloc(0) : client.rx.subarray(i);
        continue;
      }
      const len = client.rx[1];
      if (client.rx.length < len + 2) return;
      const apdu = client.rx.subarray(2, len + 2);
      client.rx = client.rx.subarray(len + 2);
      this.handleApdu(client, apdu);
    }
  }

  private handleApdu(client: Client, apdu: Buffer) {
    const c1 = apdu[0];

    if ((c1 & 0x01) === 0) {
      // I-format from the master. Track its sequence number and inspect the ASDU.
      client.vr = ((apdu.readUInt16LE(0) >> 1) + 1) & 0x7fff;
      const asdu = apdu.subarray(4);
      if (asdu.length >= 1 && asdu[0] === C_IC_NA_1) {
        this.log('[simulator] station interrogation received');
        this.sendInterrogationResponse(client);
      }
      this.sendS(client);
      return;
    }

    if ((c1 & 0x03) === 0x01) return; // S-format acknowledgement

    // U-format
    if (c1 & 0x04) {
      // STARTDT act -> con
      client.started = true;
      this.sendU(client, 0x0b);
      this.log('[simulator] data transfer started');
      // A real relay sends its present state shortly after STARTDT.
      setTimeout(() => this.sendMeasurements(COT_PERIODIC, client), 300);
    } else if (c1 & 0x10) {
      client.started = false;
      this.sendU(client, 0x23); // STOPDT con
    } else if (c1 & 0x40) {
      this.sendU(client, 0x83); // TESTFR con
    }
  }

  // ---- frame senders -----------------------------------------------------------------------

  private sendU(client: Client, control1: number) {
    client.socket.write(Buffer.from([START, 0x04, control1, 0, 0, 0]));
  }

  private sendS(client: Client) {
    const b = Buffer.alloc(6);
    b[0] = START; b[1] = 0x04; b[2] = 0x01; b[3] = 0;
    b.writeUInt16LE((client.vr << 1) & 0xfffe, 4);
    client.socket.write(b);
  }

  private sendI(client: Client, asdu: Buffer) {
    if (!client.started || client.socket.destroyed) return;
    const b = Buffer.alloc(6 + asdu.length);
    b[0] = START;
    b[1] = 4 + asdu.length;
    b.writeUInt16LE((client.vs << 1) & 0xfffe, 2);
    b.writeUInt16LE((client.vr << 1) & 0xfffe, 4);
    asdu.copy(b, 6);
    client.socket.write(b);
    client.vs = (client.vs + 1) & 0x7fff;
  }

  private broadcast(asdu: Buffer, only?: Client) {
    const targets = only ? [only] : [...this.clients];
    targets.forEach((c) => this.sendI(c, asdu));
  }

  // ---- ASDU builders -----------------------------------------------------------------------

  /** Header: type, VSQ(1 object), COT(2 bytes incl. originator), common address (2 bytes). */
  private header(typeId: number, cot: number, count = 1): Buffer {
    const h = Buffer.alloc(6);
    h[0] = typeId;
    h[1] = count & 0x7f;
    h[2] = cot;
    h[3] = 0;
    h.writeUInt16LE(this.ca, 4);
    return h;
  }

  private ioa(address: number): Buffer {
    return Buffer.from([address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff]);
  }

  private floatMeasurement(ioaAddr: number, value: number, cot: number): Buffer {
    const body = Buffer.alloc(5);
    body.writeFloatLE(value, 0);
    body[4] = 0; // quality: good
    return Buffer.concat([this.header(M_ME_NC_1, cot), this.ioa(ioaAddr), body]);
  }

  private singlePointWithTime(ioaAddr: number, on: boolean, cot: number, when = new Date()): Buffer {
    const siq = Buffer.from([on ? 0x01 : 0x00]);
    return Buffer.concat([this.header(M_SP_TB_1, cot), this.ioa(ioaAddr), siq, encodeCP56Time2a(when)]);
  }

  private doublePointWithTime(ioaAddr: number, closed: boolean, cot: number, when = new Date()): Buffer {
    // DPI: 1 = OFF/open, 2 = ON/closed
    const diq = Buffer.from([closed ? 0x02 : 0x01]);
    return Buffer.concat([this.header(M_DP_TB_1, cot), this.ioa(ioaAddr), diq, encodeCP56Time2a(when)]);
  }

  // ---- behaviour ---------------------------------------------------------------------------

  /**
   * IOAs match the built-in Siemens SIPROTEC point-map profile, so a relay registered with that
   * profile interprets this simulator correctly with no extra configuration.
   */
  private sendMeasurements(cot: number, only?: Client) {
    // Small random walk so the dashboard shows movement rather than a frozen number.
    this.state.current_A = Math.max(0, this.state.current_A + (Math.random() - 0.5) * 8);
    this.state.voltage_kV = 20 + (Math.random() - 0.5) * 0.2;
    this.state.frequency_Hz = 50 + (Math.random() - 0.5) * 0.06;

    this.broadcast(this.floatMeasurement(100, this.state.current_A, cot), only);
    this.broadcast(this.floatMeasurement(101, this.state.voltage_kV * 1000, cot), only);
    this.broadcast(this.floatMeasurement(102, this.state.frequency_Hz * 100, cot), only);
  }

  private sendInterrogationResponse(client: Client) {
    // Confirm, send the full picture, then terminate — the sequence a master expects.
    this.sendI(client, Buffer.concat([this.header(C_IC_NA_1, COT_ACTIVATION_CON), this.ioa(0), Buffer.from([20])]));
    this.sendMeasurements(COT_INTERROGATED, client);
    this.sendI(client, this.doublePointWithTime(1, this.state.breakerClosed, COT_INTERROGATED));
    this.sendI(client, Buffer.concat([this.header(C_IC_NA_1, COT_ACTIVATION_TERM), this.ioa(0), Buffer.from([20])]));
  }

  /**
   * Emit a realistic protection trip: pickup, trip, breaker opens, fault current — with the same
   * millisecond spacing a real overcurrent operation produces.
   */
  injectTrip(): void {
    if (this.clients.size === 0) {
      this.log('[simulator] trip requested but no client is connected');
      return;
    }
    const t0 = new Date();
    const faultCurrent = 2400 + Math.random() * 900;
    this.log(`[simulator] injecting protection trip (fault current ${faultCurrent.toFixed(0)} A)`);

    // Fault current first — this is what the relay measured when it decided to operate.
    this.broadcast(this.floatMeasurement(100, faultCurrent, COT_SPONTANEOUS));

    // IOA 200 = overcurrent pickup, 201 = overcurrent trip (Siemens profile).
    this.broadcast(this.singlePointWithTime(200, true, COT_SPONTANEOUS, t0));

    setTimeout(() => {
      const t1 = new Date(t0.getTime() + 166);
      this.broadcast(this.singlePointWithTime(201, true, COT_SPONTANEOUS, t1));
    }, 166);

    setTimeout(() => {
      const t2 = new Date(t0.getTime() + 224);
      this.state.breakerClosed = false;
      this.broadcast(this.doublePointWithTime(1, false, COT_SPONTANEOUS, t2));
    }, 224);

    // Reset: current collapses, elements drop off, breaker stays open until someone closes it.
    setTimeout(() => {
      this.state.current_A = 0;
      this.broadcast(this.floatMeasurement(100, 0, COT_SPONTANEOUS));
      this.broadcast(this.singlePointWithTime(200, false, COT_SPONTANEOUS));
      this.broadcast(this.singlePointWithTime(201, false, COT_SPONTANEOUS));
    }, 1200);
  }

  /** Restore the breaker so a subsequent trip is meaningful. */
  reclose(): void {
    this.state.breakerClosed = true;
    this.state.current_A = 400 + Math.random() * 30;
    this.broadcast(this.doublePointWithTime(1, true, COT_SPONTANEOUS));
    this.log('[simulator] breaker closed');
  }

  get connectedClients(): number {
    return this.clients.size;
  }
}
