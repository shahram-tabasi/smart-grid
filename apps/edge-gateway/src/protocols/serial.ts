import { SerialSettings } from '@simorgh/shared';

/**
 * Serial transport abstraction for the RS-232/RS-485 protocols (IEC 60870-5-101/103, Modbus RTU/
 * ASCII, DNP3 serial, SPA-bus, Courier).
 *
 * `serialport` is an optional dependency: a gateway deployed on an all-Ethernet station has no use
 * for it, and forcing a native build on every install would be wrong. It is therefore loaded
 * dynamically, and when it is absent the transport degrades to a loopback stub so the rest of the
 * gateway still runs and can be tested.
 */

export interface SerialTransport {
  write(data: Buffer): void;
  onData(handler: (chunk: Buffer) => void): void;
  close(): Promise<void>;
  readonly isReal: boolean;
}

class StubSerialTransport implements SerialTransport {
  readonly isReal = false;
  private handlers: Array<(chunk: Buffer) => void> = [];
  write(_data: Buffer): void {
    // A stub never fabricates protocol responses: inventing plausible-looking relay replies would
    // produce fake protection events, which is far worse than reporting no data at all.
  }
  onData(handler: (chunk: Buffer) => void): void {
    this.handlers.push(handler);
  }
  async close(): Promise<void> {
    this.handlers = [];
  }
}

export async function openSerial(settings: SerialSettings): Promise<SerialTransport> {
  let SerialPortCtor: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('serialport');
    SerialPortCtor = mod.SerialPort ?? mod;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[serial] 'serialport' is not installed; ${settings.devicePath} will not carry real traffic. ` +
        `Install it on gateways that have serial links: npm install serialport --workspace=@simorgh/edge-gateway`
    );
    return new StubSerialTransport();
  }

  return await new Promise<SerialTransport>((resolve, reject) => {
    const port = new SerialPortCtor(
      {
        path: settings.devicePath,
        baudRate: settings.baudRate,
        dataBits: settings.dataBits,
        parity: settings.parity,
        stopBits: settings.stopBits,
        autoOpen: true,
      },
      (err: Error | null) => {
        if (err) return reject(err);
      }
    );

    port.on('open', () => {
      resolve({
        isReal: true,
        write: (data: Buffer) => port.write(data),
        onData: (handler: (chunk: Buffer) => void) => port.on('data', handler),
        close: () =>
          new Promise<void>((res) => {
            port.close(() => res());
          }),
      });
    });
    port.on('error', (err: Error) => reject(err));
  });
}
