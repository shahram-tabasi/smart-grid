/**
 * Phase 2 — the complete catalogue of ways a protection relay (or its supporting infrastructure)
 * can deliver data to Simorgh Grid.
 *
 * This file is the single source of truth for "how can data reach us". It is deliberately
 * exhaustive: substation fleets are heterogeneous and decades-deep, so a real monitoring platform
 * has to speak station-bus protocols, legacy serial telecontrol protocols, industrial fieldbus
 * protocols, modern IT protocols, vendor-proprietary protocols, and the auxiliary channels
 * (file transfer, syslog, SNMP, time sync) that carry the data the primary protocol cannot.
 *
 * SECURITY INVARIANT (unchanged from Phase 1, and enforced structurally below):
 * every transport described here is READ-ONLY as far as this platform is concerned. The
 * capability model has no "write", "command", "setSetting" or "operate" capability, so there is
 * no way to describe — let alone execute — a control action through this abstraction. Adding
 * control is a separate architectural decision requiring its own review, not a new flag here.
 */

// ---------------------------------------------------------------------------------------------
// Protocol identifiers
// ---------------------------------------------------------------------------------------------

/**
 * IEC 61850 — the modern substation automation standard. Split by service, because the services
 * have radically different characteristics (MMS is client/server TCP; GOOSE is layer-2 multicast
 * with millisecond delivery; SV is a high-rate sampled stream; file services move COMTRADE).
 */
export const IEC61850_PROTOCOLS = [
  'IEC61850_MMS',
  'IEC61850_GOOSE',
  'IEC61850_SV',
  'IEC61850_FILE',
] as const;

/** IEC 60870-5 telecontrol family. -103 is the protection-specific serial companion standard. */
export const IEC60870_PROTOCOLS = [
  'IEC60870_5_104',
  'IEC60870_5_101',
  'IEC60870_5_103',
] as const;

export const DNP3_PROTOCOLS = ['DNP3_TCP', 'DNP3_SERIAL'] as const;

export const MODBUS_PROTOCOLS = ['MODBUS_TCP', 'MODBUS_RTU', 'MODBUS_ASCII'] as const;

/** Modern IT / IIoT transports, typically reached via the gateway rather than the relay itself. */
export const MODERN_PROTOCOLS = ['OPC_UA', 'MQTT', 'MQTT_SPARKPLUG_B', 'REST', 'WEBSOCKET'] as const;

/** Vendor-proprietary protocols still very much alive in installed fleets. */
export const VENDOR_PROTOCOLS = [
  'SEL_ASCII', // SEL Fast Meter / Fast SER / ASCII terminal
  'SPA_BUS', // ABB SPA-bus
  'COURIER', // Schneider / Alstom / AREVA MiCOM Courier
  'GE_EGD', // GE Ethernet Global Data
  'PROFIBUS_DP', // Siemens fieldbus
] as const;

/**
 * Auxiliary channels. These do not usually carry the primary measurement stream, but they carry
 * data the platform genuinely needs: disturbance files, device/network health, security logs, and
 * the time-sync quality that makes a millisecond fault timeline trustworthy.
 */
export const AUXILIARY_PROTOCOLS = [
  'SNMP',
  'SYSLOG',
  'FTP',
  'SFTP',
  'TFTP',
  'NTP',
  'PTP_1588',
] as const;

export const SOURCE_PROTOCOLS_V2 = [
  ...IEC61850_PROTOCOLS,
  ...IEC60870_PROTOCOLS,
  ...DNP3_PROTOCOLS,
  ...MODBUS_PROTOCOLS,
  ...MODERN_PROTOCOLS,
  ...VENDOR_PROTOCOLS,
  ...AUXILIARY_PROTOCOLS,
  'SYNTHETIC',
] as const;

export type SourceProtocolV2 = (typeof SOURCE_PROTOCOLS_V2)[number];

// ---------------------------------------------------------------------------------------------
// Capability model
// ---------------------------------------------------------------------------------------------

/**
 * How data arrives. This drives scheduling in the Edge Gateway: POLL protocols need a poll loop,
 * PUSH protocols need a listener, and many protocols do both (poll for measurements, push for
 * events).
 */
export type DataDeliveryMode = 'POLL' | 'PUSH' | 'POLL_AND_PUSH' | 'FILE_TRANSFER';

export type TransportLayer =
  | 'TCP'
  | 'UDP'
  | 'ETHERNET_LAYER2' // GOOSE / SV — no IP layer at all
  | 'SERIAL_RS232'
  | 'SERIAL_RS485'
  | 'FIELDBUS';

/**
 * Time-sync quality achievable on this channel. This is not decoration: the spec requires a
 * millisecond-precision fault timeline, and a timeline is only as good as the worst clock in it.
 * The gateway stamps every event with the quality of the clock that produced it.
 */
export type TimeSyncQuality =
  | 'SUB_MICROSECOND' // PTP / IEEE 1588 with hardware timestamping
  | 'SUB_MILLISECOND' // GPS-disciplined IRIG-B or good PTP
  | 'MILLISECOND' // well-behaved NTP on a quiet LAN
  | 'SECOND' // basic NTP / SNTP
  | 'GATEWAY_STAMPED' // relay gives no usable clock; gateway stamps on arrival (lowest trust)
  | 'UNKNOWN';

export interface ProtocolCapabilities {
  /** Can carry live analogue measurements (currents, voltages, frequency, power). */
  measurements: boolean;
  /** Can carry binary status (breaker position, relay pickup/trip contacts). */
  statusPoints: boolean;
  /** Can deliver time-tagged event/SOE records rather than just present state. */
  sequenceOfEvents: boolean;
  /** Can deliver protection-specific fault records (fault current, distance, trip cause). */
  faultRecords: boolean;
  /** Can transfer COMTRADE / oscillography / disturbance files. */
  disturbanceFiles: boolean;
  /** Can report device self-diagnostics and health. */
  deviceHealth: boolean;
  /** Can report the relay's active setting group (read-only — we never change it). */
  settingGroupRead: boolean;
  /** Delivers unsolicited/spontaneous data without being polled. */
  unsolicitedReporting: boolean;
  /** Typical achievable event delivery latency, milliseconds, on a healthy network. */
  typicalLatencyMs: number;
  /** Best time-sync quality normally achievable when the channel is properly engineered. */
  bestTimeSyncQuality: TimeSyncQuality;
}

/**
 * How prominently a protocol is offered in the UI.
 *
 * The catalogue is deliberately exhaustive — a real fleet needs all of it eventually — but showing
 * thirty options to someone connecting their first relay is an obstacle, not a feature. Tiers let
 * the interface lead with the handful that will actually work today and keep the rest one click away.
 *
 *  RECOMMENDED  talks to real hardware over Ethernet with no extra setup. Start here.
 *  AVAILABLE    works, but needs serial hardware, an extra npm package, or is a supporting channel
 *               rather than a primary data source.
 *  ADVANCED     needs a native stack or vendor SDK bound first, or is a legacy/rare protocol kept
 *               for fleets that still run it.
 */
export type ProtocolTier = 'RECOMMENDED' | 'AVAILABLE' | 'ADVANCED';

export interface ProtocolDescriptor {
  protocol: SourceProtocolV2;
  /** UI prominence — see ProtocolTier. */
  tier: ProtocolTier;
  /** Human-readable name for the UI. */
  displayName: string;
  /** Family grouping for the UI and for reporting. */
  family: 'IEC61850' | 'IEC60870' | 'DNP3' | 'MODBUS' | 'MODERN' | 'VENDOR' | 'AUXILIARY' | 'DEMO';
  transport: TransportLayer;
  deliveryMode: DataDeliveryMode;
  /** Default TCP/UDP port, where the protocol has a well-known one. */
  defaultPort?: number;
  capabilities: ProtocolCapabilities;
  /** Which relay vendors most commonly speak this in the field. */
  commonVendors: string[];
  /**
   * Implementation status in this codebase. Being explicit here is deliberate — an engineer
   * commissioning a site needs to know which drivers talk to real hardware today versus which
   * need a native library or vendor SDK wired in first.
   */
  implementation: 'NATIVE' | 'LIBRARY_BACKED' | 'ADAPTER_REQUIRED' | 'SIMULATED';
  /** Operational notes surfaced in the admin UI and the operations manual. */
  notes: string;
}

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

const caps = (c: Partial<ProtocolCapabilities>): ProtocolCapabilities => ({
  measurements: false,
  statusPoints: false,
  sequenceOfEvents: false,
  faultRecords: false,
  disturbanceFiles: false,
  deviceHealth: false,
  settingGroupRead: false,
  unsolicitedReporting: false,
  typicalLatencyMs: 1000,
  bestTimeSyncQuality: 'UNKNOWN',
  ...c,
});

export const PROTOCOL_CATALOGUE: Record<SourceProtocolV2, ProtocolDescriptor> = {
  // --- IEC 61850 -------------------------------------------------------------------------------
  IEC61850_MMS: {
    protocol: 'IEC61850_MMS',
    tier: 'ADVANCED',
    displayName: 'IEC 61850 MMS (station bus)',
    family: 'IEC61850',
    transport: 'TCP',
    deliveryMode: 'POLL_AND_PUSH',
    defaultPort: 102,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      faultRecords: true,
      disturbanceFiles: true,
      deviceHealth: true,
      settingGroupRead: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 100,
      bestTimeSyncQuality: 'SUB_MILLISECOND',
    }),
    commonVendors: ['Siemens', 'ABB', 'Hitachi Energy', 'Schneider Electric', 'SEL', 'GE Multilin'],
    implementation: 'ADAPTER_REQUIRED',
    notes:
      'Primary modern channel. Uses buffered report control blocks (BRCB) so events survive a short ' +
      'connection loss and are re-delivered on reconnect. Needs a native MMS stack (libiec61850) ' +
      'bound through the adapter; runs fully in simulator mode without it.',
  },
  IEC61850_GOOSE: {
    protocol: 'IEC61850_GOOSE',
    tier: 'ADVANCED',
    displayName: 'IEC 61850 GOOSE (layer-2 multicast)',
    family: 'IEC61850',
    transport: 'ETHERNET_LAYER2',
    deliveryMode: 'PUSH',
    capabilities: caps({
      statusPoints: true,
      sequenceOfEvents: true,
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 4,
      bestTimeSyncQuality: 'SUB_MILLISECOND',
    }),
    commonVendors: ['Siemens', 'ABB', 'Hitachi Energy', 'Schneider Electric', 'GE Multilin'],
    implementation: 'ADAPTER_REQUIRED',
    notes:
      'Fastest available signal — trip and interlock messages arrive in single-digit milliseconds. ' +
      'Not routable: the gateway must sit on the same layer-2 station bus VLAN. Subscribing requires ' +
      'a raw/AF_PACKET socket, so the gateway process needs CAP_NET_RAW. GOOSE carries a state number ' +
      'and sequence number; a stNum jump is itself a monitorable event.',
  },
  IEC61850_SV: {
    protocol: 'IEC61850_SV',
    tier: 'ADVANCED',
    displayName: 'IEC 61850-9-2 Sampled Values',
    family: 'IEC61850',
    transport: 'ETHERNET_LAYER2',
    deliveryMode: 'PUSH',
    capabilities: caps({
      measurements: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 1,
      bestTimeSyncQuality: 'SUB_MICROSECOND',
    }),
    commonVendors: ['ABB', 'Hitachi Energy', 'Siemens'],
    implementation: 'ADAPTER_REQUIRED',
    notes:
      'Digital instrument-transformer stream from merging units, typically 80 samples/cycle. Very ' +
      'high rate — the gateway aggregates to RMS values and only forwards derived measurements ' +
      'upstream, never raw sample streams, or it would swamp the event bus. Requires PTP time sync.',
  },
  IEC61850_FILE: {
    protocol: 'IEC61850_FILE',
    tier: 'ADVANCED',
    displayName: 'IEC 61850 MMS file services',
    family: 'IEC61850',
    transport: 'TCP',
    deliveryMode: 'FILE_TRANSFER',
    defaultPort: 102,
    capabilities: caps({
      disturbanceFiles: true,
      faultRecords: true,
      typicalLatencyMs: 5000,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Siemens', 'ABB', 'Hitachi Energy', 'Schneider Electric'],
    implementation: 'ADAPTER_REQUIRED',
    notes:
      'Pulls COMTRADE sets (.CFG/.DAT/.HDR/.INF) from the relay COMTRADE directory after a trip. ' +
      'Triggered by a disturbance-record-available indication rather than polled blindly.',
  },

  // --- IEC 60870-5 -----------------------------------------------------------------------------
  IEC60870_5_104: {
    protocol: 'IEC60870_5_104',
    tier: 'RECOMMENDED',
    displayName: 'IEC 60870-5-104 (telecontrol over TCP)',
    family: 'IEC60870',
    transport: 'TCP',
    deliveryMode: 'POLL_AND_PUSH',
    defaultPort: 2404,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 200,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Siemens', 'ABB', 'Schneider Electric', 'GE Multilin', 'Other'],
    implementation: 'NATIVE',
    notes:
      'The workhorse link to most Iranian utility SCADA masters. Fully implemented here: APCI ' +
      'framing, I/S/U frames, k/w flow control, station interrogation, and CP56Time2a millisecond ' +
      'timestamps. Monitor direction only — command ASDUs are never generated.',
  },
  IEC60870_5_101: {
    protocol: 'IEC60870_5_101',
    tier: 'AVAILABLE',
    displayName: 'IEC 60870-5-101 (telecontrol over serial)',
    family: 'IEC60870',
    transport: 'SERIAL_RS485',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      typicalLatencyMs: 1500,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Siemens', 'ABB', 'Other'],
    implementation: 'NATIVE',
    notes:
      'Serial ancestor of -104, still found on older RTU links. Unbalanced mode: the gateway polls ' +
      'each link address in turn. Shares the ASDU decoder with -104.',
  },
  IEC60870_5_103: {
    protocol: 'IEC60870_5_103',
    tier: 'AVAILABLE',
    displayName: 'IEC 60870-5-103 (protection equipment companion standard)',
    family: 'IEC60870',
    transport: 'SERIAL_RS485',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      faultRecords: true,
      disturbanceFiles: true,
      deviceHealth: true,
      typicalLatencyMs: 1500,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Siemens', 'ABB', 'Schneider Electric'],
    implementation: 'NATIVE',
    notes:
      'Purpose-built for protection relays: it carries standardised protection information numbers ' +
      '(INF) for pickup/trip per protection function, plus disturbance record upload. The richest ' +
      'legacy source of genuine protection data — worth keeping for older SIPROTEC 4 fleets.',
  },

  // --- DNP3 ------------------------------------------------------------------------------------
  DNP3_TCP: {
    protocol: 'DNP3_TCP',
    tier: 'RECOMMENDED',
    displayName: 'DNP3 over TCP',
    family: 'DNP3',
    transport: 'TCP',
    deliveryMode: 'POLL_AND_PUSH',
    defaultPort: 20000,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 250,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['SEL', 'GE Multilin', 'Schneider Electric'],
    implementation: 'NATIVE',
    notes:
      'Class 0/1/2/3 polling plus unsolicited responses. Event classes map cleanly onto our severity ' +
      'model. Reads only: function codes are restricted to READ (0x01) and confirm — the driver ' +
      'cannot emit SELECT/OPERATE/DIRECT_OPERATE.',
  },
  DNP3_SERIAL: {
    protocol: 'DNP3_SERIAL',
    tier: 'AVAILABLE',
    displayName: 'DNP3 over serial',
    family: 'DNP3',
    transport: 'SERIAL_RS485',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      typicalLatencyMs: 2000,
      bestTimeSyncQuality: 'SECOND',
    }),
    commonVendors: ['SEL', 'GE Multilin'],
    implementation: 'NATIVE',
    notes: 'Same application layer as DNP3/TCP over an RS-485 multidrop. Slower poll cycles.',
  },

  // --- Modbus ----------------------------------------------------------------------------------
  MODBUS_TCP: {
    protocol: 'MODBUS_TCP',
    tier: 'RECOMMENDED',
    displayName: 'Modbus TCP',
    family: 'MODBUS',
    transport: 'TCP',
    deliveryMode: 'POLL',
    defaultPort: 502,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      typicalLatencyMs: 500,
      bestTimeSyncQuality: 'GATEWAY_STAMPED',
    }),
    commonVendors: ['Schneider Electric', 'GE Multilin', 'SEL', 'Other'],
    implementation: 'LIBRARY_BACKED',
    notes:
      'Ubiquitous and simple, but semantically poor: it carries register values with no timestamps, ' +
      'no event queue and no self-description. Events derived from Modbus are gateway-stamped, so ' +
      'they are explicitly marked lower-trust in the fault timeline. Register maps are per-model and ' +
      'come from the register-map profiles, not hard-coded.',
  },
  MODBUS_RTU: {
    protocol: 'MODBUS_RTU',
    tier: 'AVAILABLE',
    displayName: 'Modbus RTU (serial)',
    family: 'MODBUS',
    transport: 'SERIAL_RS485',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      typicalLatencyMs: 2000,
      bestTimeSyncQuality: 'GATEWAY_STAMPED',
    }),
    commonVendors: ['Schneider Electric', 'Other'],
    implementation: 'LIBRARY_BACKED',
    notes: 'Binary framing over RS-485 multidrop, CRC-16 checked. Same register-map profiles as Modbus TCP.',
  },
  MODBUS_ASCII: {
    protocol: 'MODBUS_ASCII',
    tier: 'AVAILABLE',
    displayName: 'Modbus ASCII (serial)',
    family: 'MODBUS',
    transport: 'SERIAL_RS232',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      typicalLatencyMs: 3000,
      bestTimeSyncQuality: 'GATEWAY_STAMPED',
    }),
    commonVendors: ['Other'],
    implementation: 'LIBRARY_BACKED',
    notes: 'Rare legacy variant; LRC-checked ASCII framing. Included for completeness on old panels.',
  },

  // --- Modern IT / IIoT ------------------------------------------------------------------------
  OPC_UA: {
    protocol: 'OPC_UA',
    tier: 'AVAILABLE',
    displayName: 'OPC UA',
    family: 'MODERN',
    transport: 'TCP',
    deliveryMode: 'POLL_AND_PUSH',
    defaultPort: 4840,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 200,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Siemens', 'ABB', 'Schneider Electric'],
    implementation: 'LIBRARY_BACKED',
    notes:
      'Usually exposed by the substation gateway or SCADA server rather than the relay itself. ' +
      'Subscription-based monitored items give change-driven updates. Connects with signed+encrypted ' +
      'security policy and a client certificate; anonymous/None is rejected outside simulator mode.',
  },
  MQTT: {
    protocol: 'MQTT',
    tier: 'AVAILABLE',
    displayName: 'MQTT',
    family: 'MODERN',
    transport: 'TCP',
    deliveryMode: 'PUSH',
    defaultPort: 8883,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 150,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Other'],
    implementation: 'LIBRARY_BACKED',
    notes:
      'Used where a modern edge device already publishes telemetry. Always TLS (8883); the driver ' +
      'subscribes only — it never publishes to a topic a relay or gateway subscribes to, so it ' +
      'cannot become a command path.',
  },
  MQTT_SPARKPLUG_B: {
    protocol: 'MQTT_SPARKPLUG_B',
    tier: 'AVAILABLE',
    displayName: 'MQTT Sparkplug B',
    family: 'MODERN',
    transport: 'TCP',
    deliveryMode: 'PUSH',
    defaultPort: 8883,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 150,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Other'],
    implementation: 'LIBRARY_BACKED',
    notes:
      'Sparkplug B adds birth/death certificates and a typed metric payload on top of MQTT, so device ' +
      'online/offline state is explicit rather than inferred from a missed poll. NBIRTH/DBIRTH give ' +
      'us the tag list automatically.',
  },
  REST: {
    protocol: 'REST',
    tier: 'RECOMMENDED',
    displayName: 'Vendor REST / HTTP API',
    family: 'MODERN',
    transport: 'TCP',
    deliveryMode: 'POLL',
    defaultPort: 443,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      faultRecords: true,
      deviceHealth: true,
      settingGroupRead: true,
      typicalLatencyMs: 800,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['SEL', 'Siemens', 'Other'],
    implementation: 'NATIVE',
    notes:
      'Newer relays and most substation gateways expose an HTTPS API. Restricted to GET requests by ' +
      'construction in the driver, which is the cleanest possible proof it cannot issue a control action.',
  },
  WEBSOCKET: {
    protocol: 'WEBSOCKET',
    tier: 'AVAILABLE',
    displayName: 'WebSocket stream',
    family: 'MODERN',
    transport: 'TCP',
    deliveryMode: 'PUSH',
    defaultPort: 443,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 120,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Other'],
    implementation: 'NATIVE',
    notes: 'Streaming variant of the vendor HTTP API, where offered. Receive-only.',
  },

  // --- Vendor-proprietary ----------------------------------------------------------------------
  SEL_ASCII: {
    protocol: 'SEL_ASCII',
    tier: 'RECOMMENDED',
    displayName: 'SEL ASCII / Fast Meter / Fast SER',
    family: 'VENDOR',
    transport: 'TCP',
    deliveryMode: 'POLL_AND_PUSH',
    defaultPort: 23,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      faultRecords: true,
      disturbanceFiles: true,
      deviceHealth: true,
      settingGroupRead: true,
      typicalLatencyMs: 400,
      bestTimeSyncQuality: 'SUB_MILLISECOND',
    }),
    commonVendors: ['SEL'],
    implementation: 'NATIVE',
    notes:
      'SEL relays speak a terminal protocol over Telnet/serial. Fast Meter gives binary metering, ' +
      'Fast SER gives unsolicited sequence-of-events with sub-millisecond stamps when the relay is ' +
      'IRIG-B synced, and the EVE/CEV commands retrieve event reports. The driver whitelists only ' +
      'read commands (METER, STATUS, HISTORY, EVE, CEV, SER, TARGET) — it refuses to emit OPEN, ' +
      'CLOSE, PULSE, SET, or any breaker-control command, and the ACCESS level-2 escalation that ' +
      'those would require is never performed.',
  },
  SPA_BUS: {
    protocol: 'SPA_BUS',
    tier: 'AVAILABLE',
    displayName: 'ABB SPA-bus',
    family: 'VENDOR',
    transport: 'SERIAL_RS485',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      faultRecords: true,
      deviceHealth: true,
      typicalLatencyMs: 2000,
      bestTimeSyncQuality: 'SECOND',
    }),
    commonVendors: ['ABB'],
    implementation: 'NATIVE',
    notes:
      'ASCII master/slave protocol on older ABB feeder terminals (SPACOM/REF54x era). Still common in ' +
      'refurbishment projects where only part of a substation has been modernised.',
  },
  COURIER: {
    protocol: 'COURIER',
    tier: 'ADVANCED',
    displayName: 'Courier (MiCOM / Alstom / AREVA)',
    family: 'VENDOR',
    transport: 'SERIAL_RS485',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      faultRecords: true,
      disturbanceFiles: true,
      deviceHealth: true,
      settingGroupRead: true,
      typicalLatencyMs: 2000,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['Schneider Electric'],
    implementation: 'ADAPTER_REQUIRED',
    notes:
      'K-Bus/Courier on MiCOM P-series. Menu-database addressed. Needs a K-Bus to RS-232 converter ' +
      '(KITZ) in the loop on genuinely old installations.',
  },
  GE_EGD: {
    protocol: 'GE_EGD',
    tier: 'AVAILABLE',
    displayName: 'GE Ethernet Global Data',
    family: 'VENDOR',
    transport: 'UDP',
    deliveryMode: 'PUSH',
    defaultPort: 18246,
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 50,
      bestTimeSyncQuality: 'MILLISECOND',
    }),
    commonVendors: ['GE Multilin'],
    implementation: 'NATIVE',
    notes:
      'GE produces cyclic UDP exchange blocks at a configured rate. Receive-only by nature, which ' +
      'makes it a safe high-rate status source on GE fleets.',
  },
  PROFIBUS_DP: {
    protocol: 'PROFIBUS_DP',
    tier: 'ADVANCED',
    displayName: 'PROFIBUS DP',
    family: 'VENDOR',
    transport: 'FIELDBUS',
    deliveryMode: 'POLL',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      typicalLatencyMs: 100,
      bestTimeSyncQuality: 'GATEWAY_STAMPED',
    }),
    commonVendors: ['Siemens'],
    implementation: 'ADAPTER_REQUIRED',
    notes:
      'Reached through a PROFIBUS-to-Ethernet proxy rather than directly; the gateway treats the proxy ' +
      'as the endpoint. Mostly seen on motor-protection and process-adjacent panels.',
  },

  // --- Auxiliary -------------------------------------------------------------------------------
  SNMP: {
    protocol: 'SNMP',
    tier: 'AVAILABLE',
    displayName: 'SNMP (device & network health)',
    family: 'AUXILIARY',
    transport: 'UDP',
    deliveryMode: 'POLL_AND_PUSH',
    defaultPort: 161,
    capabilities: caps({
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 500,
      bestTimeSyncQuality: 'GATEWAY_STAMPED',
    }),
    commonVendors: ['Other'],
    implementation: 'NATIVE',
    notes:
      'Monitors the path, not the protection: switches, media converters, the industrial gateway ' +
      'itself, UPS and power supplies. SNMP traps often reveal why a relay went quiet — which is ' +
      'exactly the evidence that stops the AI misreading a network fault as a protection operation. ' +
      'SNMPv3 with authPriv only; v1/v2c community strings are refused outside simulator mode.',
  },
  SYSLOG: {
    protocol: 'SYSLOG',
    tier: 'AVAILABLE',
    displayName: 'Syslog (relay & security events)',
    family: 'AUXILIARY',
    transport: 'UDP',
    deliveryMode: 'PUSH',
    defaultPort: 514,
    capabilities: caps({
      sequenceOfEvents: true,
      deviceHealth: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 100,
      bestTimeSyncQuality: 'SECOND',
    }),
    commonVendors: ['SEL', 'Siemens', 'ABB', 'Other'],
    implementation: 'NATIVE',
    notes:
      'Modern relays emit syslog for setting changes, failed logins, self-test failures and firmware ' +
      'events. This is the primary cyber-security telemetry from the OT side and feeds the audit ' +
      'trail. RFC 5424 parsed; RFC 3164 tolerated.',
  },
  FTP: {
    protocol: 'FTP',
    tier: 'ADVANCED',
    displayName: 'FTP (disturbance file retrieval)',
    family: 'AUXILIARY',
    transport: 'TCP',
    deliveryMode: 'FILE_TRANSFER',
    defaultPort: 21,
    capabilities: caps({ disturbanceFiles: true, typicalLatencyMs: 8000, bestTimeSyncQuality: 'UNKNOWN' }),
    commonVendors: ['Siemens', 'ABB', 'GE Multilin'],
    implementation: 'NATIVE',
    notes:
      'Legacy COMTRADE pull. Plaintext, so it is only permitted inside the substation OT segment and ' +
      'never across the DMZ boundary; SFTP is preferred wherever the relay supports it.',
  },
  SFTP: {
    protocol: 'SFTP',
    tier: 'AVAILABLE',
    displayName: 'SFTP (disturbance file retrieval)',
    family: 'AUXILIARY',
    transport: 'TCP',
    deliveryMode: 'FILE_TRANSFER',
    defaultPort: 22,
    capabilities: caps({ disturbanceFiles: true, typicalLatencyMs: 8000, bestTimeSyncQuality: 'UNKNOWN' }),
    commonVendors: ['SEL', 'Siemens', 'Other'],
    implementation: 'NATIVE',
    notes: 'Preferred file-retrieval channel. Key-based auth; host keys pinned per site.',
  },
  TFTP: {
    protocol: 'TFTP',
    tier: 'ADVANCED',
    displayName: 'TFTP (disturbance file retrieval)',
    family: 'AUXILIARY',
    transport: 'UDP',
    deliveryMode: 'FILE_TRANSFER',
    defaultPort: 69,
    capabilities: caps({ disturbanceFiles: true, typicalLatencyMs: 10000, bestTimeSyncQuality: 'UNKNOWN' }),
    commonVendors: ['Other'],
    implementation: 'NATIVE',
    notes: 'Only for old IEDs that offer nothing better. No authentication — OT segment only, read opcode only.',
  },
  NTP: {
    protocol: 'NTP',
    tier: 'AVAILABLE',
    displayName: 'NTP time-sync supervision',
    family: 'AUXILIARY',
    transport: 'UDP',
    deliveryMode: 'POLL',
    defaultPort: 123,
    capabilities: caps({ deviceHealth: true, typicalLatencyMs: 200, bestTimeSyncQuality: 'MILLISECOND' }),
    commonVendors: ['Other'],
    implementation: 'NATIVE',
    notes:
      'Supervises the clock the timeline depends on. The gateway measures offset and dispersion ' +
      'against the site time source and downgrades the recorded time-sync quality of every event from ' +
      'that site when the clock drifts — so a fault timeline never claims more precision than it has.',
  },
  PTP_1588: {
    protocol: 'PTP_1588',
    tier: 'ADVANCED',
    displayName: 'PTP / IEEE 1588 time-sync supervision',
    family: 'AUXILIARY',
    transport: 'ETHERNET_LAYER2',
    deliveryMode: 'PUSH',
    capabilities: caps({ deviceHealth: true, typicalLatencyMs: 10, bestTimeSyncQuality: 'SUB_MICROSECOND' }),
    commonVendors: ['ABB', 'Hitachi Energy', 'Siemens'],
    implementation: 'ADAPTER_REQUIRED',
    notes:
      'Required wherever Sampled Values are used and strongly recommended for GOOSE-heavy stations. ' +
      'The gateway watches the PTP grandmaster identity and the announce messages; a grandmaster ' +
      'change is an event worth raising because it can silently shift the whole station clock.',
  },

  // --- Demo ------------------------------------------------------------------------------------
  SYNTHETIC: {
    protocol: 'SYNTHETIC',
    tier: 'ADVANCED',
    displayName: 'Synthetic (demo data)',
    family: 'DEMO',
    transport: 'TCP',
    deliveryMode: 'PUSH',
    capabilities: caps({
      measurements: true,
      statusPoints: true,
      sequenceOfEvents: true,
      faultRecords: true,
      disturbanceFiles: true,
      deviceHealth: true,
      settingGroupRead: true,
      unsolicitedReporting: true,
      typicalLatencyMs: 0,
      bestTimeSyncQuality: 'GATEWAY_STAMPED',
    }),
    commonVendors: [],
    implementation: 'SIMULATED',
    notes: 'Demo/synthetic source. Everything it produces is flagged is_demo_data = true.',
  },
};

/** Protocols that can deliver genuine time-tagged protection data (used to rank source trust). */
export function isProtectionGradeSource(protocol: SourceProtocolV2): boolean {
  const d = PROTOCOL_CATALOGUE[protocol];
  return d.capabilities.faultRecords || d.capabilities.sequenceOfEvents;
}

/**
 * Ranks how much we trust a timestamp arriving on this channel. Used when merging events from
 * several sources into one millisecond fault timeline: a GOOSE message and a Modbus poll that
 * appear to describe the same instant are not equally believable.
 */
export const TIME_SYNC_TRUST_RANK: Record<TimeSyncQuality, number> = {
  SUB_MICROSECOND: 5,
  SUB_MILLISECOND: 4,
  MILLISECOND: 3,
  SECOND: 2,
  GATEWAY_STAMPED: 1,
  UNKNOWN: 0,
};

export function protocolsByFamily(family: ProtocolDescriptor['family']): ProtocolDescriptor[] {
  return Object.values(PROTOCOL_CATALOGUE).filter((p) => p.family === family);
}

/** Protocols to lead with when someone is connecting a relay for the first time. */
export function recommendedProtocols(): ProtocolDescriptor[] {
  return Object.values(PROTOCOL_CATALOGUE).filter((p) => p.tier === 'RECOMMENDED');
}

export function protocolsByTier(tier: ProtocolTier): ProtocolDescriptor[] {
  return Object.values(PROTOCOL_CATALOGUE).filter((p) => p.tier === tier);
}
