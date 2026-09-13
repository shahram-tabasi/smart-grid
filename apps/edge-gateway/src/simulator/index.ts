import 'dotenv/config';
import { Iec104RelaySimulator } from './relaySimulator';

/**
 * Standalone runner for the relay simulator.
 *
 *   npm run simulator --workspace=@simorgh/edge-gateway
 *
 * Options via environment:
 *   SIM_PORT=2404            listen port
 *   SIM_COMMON_ADDRESS=1     IEC 104 common address
 *   SIM_TRIP_EVERY=0         inject a trip every N seconds (0 = only on demand)
 *
 * While it runs, press ENTER to inject a trip and 'c' + ENTER to close the breaker again.
 */
async function main() {
  const sim = new Iec104RelaySimulator({
    port: Number(process.env.SIM_PORT ?? 2404),
    commonAddress: Number(process.env.SIM_COMMON_ADDRESS ?? 1),
    autoTripEverySec: Number(process.env.SIM_TRIP_EVERY ?? 0),
    measurementIntervalSec: Number(process.env.SIM_MEASUREMENT_INTERVAL ?? 10),
  });

  await sim.start();

  console.log('');
  console.log('  Register a relay with these settings:');
  console.log(`    protocol   IEC 60870-5-104`);
  console.log(`    host       127.0.0.1   (or this machine's IP, if the gateway runs elsewhere)`);
  console.log(`    port       ${process.env.SIM_PORT ?? 2404}`);
  console.log(`    point map  Siemens SIPROTEC (generic)`);
  console.log('');
  console.log('  Then run the gateway with SIMULATE=false.');
  console.log('');
  console.log('  ENTER      inject a protection trip');
  console.log('  c + ENTER  close the breaker again');
  console.log('  Ctrl+C     stop');
  console.log('');

  // Interactive control, so a trip can be demonstrated on cue during a presentation.
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      const key = chunk.trim().toLowerCase();
      if (key === 'c') sim.reclose();
      else sim.injectTrip();
    });
  }

  const shutdown = async () => {
    console.log('\n[simulator] stopping...');
    await sim.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[simulator] failed to start:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`[simulator] port ${process.env.SIM_PORT ?? 2404} is already in use. Set SIM_PORT to something else.`);
  }
  process.exit(1);
});
