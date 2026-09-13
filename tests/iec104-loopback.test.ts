/**
 * End-to-end IEC 60870-5-104 protocol test.
 *
 * Runs the real Iec104Driver against the real Iec104RelaySimulator over a real TCP socket. Nothing
 * is mocked: APCI framing, STARTDT negotiation, station interrogation, ASDU encoding and decoding,
 * CP56Time2a timestamps and the point map are all exercised.
 *
 * This is the test that would have caught a framing or decoding bug before a site visit, so it
 * checks meaning and not merely that bytes moved: that measurements arrive with correct scaling,
 * that a trip is reported as a protection operation with the right function, that the breaker
 * change is seen, and that the timestamps come from the device rather than being stamped on arrival.
 *
 * Run with: npm run test:protocol
 */
import { Iec104RelaySimulator } from '../apps/edge-gateway/src/simulator/relaySimulator';
import { Iec104Driver } from '../apps/edge-gateway/src/protocols/iec60870/Iec104Driver';
import { BUILT_IN_POINT_MAPS } from '../apps/edge-gateway/src/protocols/pointMap';
import type { CommPath, RelayCommProfile, UnifiedEvent } from '@simorgh/shared';

const PORT = 24041; // not the standard 2404, so a real gateway on this machine is unaffected

const path: CommPath = {
  pathId: 'test-104',
  protocol: 'IEC60870_5_104',
  role: 'PRIMARY',
  host: '127.0.0.1',
  port: PORT,
  addressing: { commonAddress: 1, ioaSize: 3, cotSize: 2, caSize: 2 },
  pollIntervalMs: 5000,
  supervisionTimeoutSec: 30,
  enabled: true,
};

const profile: RelayCommProfile = {
  relayId: 'test-relay',
  relayCode: 'TEST-R01',
  manufacturer: 'Siemens',
  model: 'SIPROTEC 5 7SJ82',
  pointMapProfileId: 'siemens-siprotec-generic',
  paths: [path],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const sim = new Iec104RelaySimulator({ port: PORT, commonAddress: 1, log: () => undefined });
  await sim.start();

  // simulate:false — we want the real socket path, not the driver's canned responses.
  const driver = new Iec104Driver(BUILT_IN_POINT_MAPS, { simulate: false });
  const events: UnifiedEvent[] = [];

  await driver.connect(path, profile);
  driver.subscribeEvents(path, profile, (e) => events.push(e));

  // Allow STARTDT + interrogation + the first cyclic values to arrive.
  await sleep(1500);

  const diag = driver.diagnostics(path);
  check('driver connects to the relay over TCP', diag.state === 'CONNECTED', `state=${diag.state}`);
  check('simulator sees the client', sim.connectedClients === 1, `clients=${sim.connectedClients}`);
  check('frames received and decoded', diag.framesReceived > 0, `framesReceived=${diag.framesReceived}`);
  check('no frames rejected as malformed', diag.framesRejected === 0, `framesRejected=${diag.framesRejected}`);

  // --- measurements ---------------------------------------------------------------------------
  const status = await driver.readStatus(path, profile);
  await sleep(600);
  const after = await driver.readStatus(path, profile);

  const current = after.measurements.current_A;
  check(
    'current decoded and scaled into a plausible range',
    typeof current === 'number' && current > 100 && current < 1000,
    `current_A=${current}`
  );
  const voltage = after.measurements.voltage_kV;
  check(
    'voltage decoded with the point-map scale factor applied',
    typeof voltage === 'number' && voltage > 15 && voltage < 25,
    `voltage_kV=${voltage}`
  );
  check('breaker position read from the relay', after.breakerStatus === 'CLOSED', `breakerStatus=${after.breakerStatus}`);
  check('timestamps declared as device-grade, not gateway-stamped', after.timeSyncQuality === 'MILLISECOND', after.timeSyncQuality);

  // --- protection trip ------------------------------------------------------------------------
  events.length = 0;
  sim.injectTrip();
  await sleep(1800);

  const trips = events.filter((e) => e.eventType === 'PROTECTION_TRIP');
  const pickups = events.filter((e) => e.eventType === 'PROTECTION_PICKUP');
  const breakerChanges = events.filter((e) => e.eventType === 'BREAKER_STATE_CHANGE');

  check('protection pickup received', pickups.length >= 1, `${pickups.length} pickup event(s)`);
  check('protection trip received', trips.length >= 1, `${trips.length} trip event(s)`);
  check(
    'trip carries the correct protection function from the point map',
    trips[0]?.protectionFunction === 'OVERCURRENT',
    `protectionFunction=${trips[0]?.protectionFunction}`
  );
  check('trip severity is CRITICAL', trips[0]?.severity === 'CRITICAL', `severity=${trips[0]?.severity}`);
  check('breaker opening detected', breakerChanges.some((e) => e.breakerStatus === 'OPEN'), `${breakerChanges.length} breaker event(s)`);

  // The whole point of CP56Time2a: the relay's own clock, not ours.
  check(
    'trip timestamp comes from the relay, not the gateway',
    trips[0]?.timeSyncQuality === 'MILLISECOND',
    `timeSyncQuality=${trips[0]?.timeSyncQuality}`
  );

  // Pickup must precede trip — the ordering a fault timeline depends on.
  if (pickups.length && trips.length) {
    const dt = new Date(trips[0].timestamp).getTime() - new Date(pickups[0].timestamp).getTime();
    check('pickup precedes trip, with a realistic operating time', dt > 0 && dt < 2000, `trip - pickup = ${dt} ms`);
  } else {
    check('pickup precedes trip', false, 'missing pickup or trip');
  }

  check('every event is marked as real, not synthetic', events.every((e) => e.synthetic === false), 'some events flagged synthetic');
  check('events carry the originating path id', events.every((e) => e.sourcePathId === path.pathId));

  // --- reclose --------------------------------------------------------------------------------
  events.length = 0;
  sim.reclose();
  await sleep(800);
  check(
    'breaker close detected after reclose',
    events.some((e) => e.eventType === 'BREAKER_STATE_CHANGE' && e.breakerStatus === 'CLOSED'),
    `${events.length} event(s) after reclose`
  );

  await driver.disconnect(path);
  await sim.stop();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('test harness error:', err);
  process.exit(1);
});
