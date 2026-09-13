import { ProtectionFunctionCode, SourceProtocolV2 } from '@simorgh/shared';

/**
 * Point / register maps.
 *
 * Semantically poor protocols (Modbus above all, but also DNP3 and IEC 60870-5-x to a degree)
 * deliver a number at an address with no indication of what it means. The meaning lives in the
 * vendor's documentation, per relay model. Hard-coding those addresses into driver code is exactly
 * the vendor lock-in the specification forbids, so instead every driver resolves addresses through
 * this table, and the table is data — loadable per model, per site, and overridable per relay.
 *
 * IEC 61850 is the exception: it is self-describing (logical nodes carry their own semantics), so
 * its driver maps by data-object path rather than needing a numeric map.
 */

export type PointKind =
  | 'MEASUREMENT'
  | 'BREAKER_POSITION'
  | 'PROTECTION_PICKUP'
  | 'PROTECTION_TRIP'
  | 'DEVICE_HEALTH'
  | 'SETTING_GROUP'
  | 'COUNTER';

export interface PointDefinition {
  /** Numeric address: Modbus register, DNP3 point index, IEC 60870 IOA, IEC 103 INF number. */
  address: number;
  name: string;
  kind: PointKind;
  /** Multiply the raw value by this to reach engineering units. */
  scale?: number;
  unit?: string;
  protectionFunction?: ProtectionFunctionCode;
  /** For Modbus: how to interpret the register(s). */
  dataType?: 'UINT16' | 'INT16' | 'UINT32' | 'INT32' | 'FLOAT32' | 'BOOL';
  /** For Modbus: which table the address lives in. */
  registerTable?: 'HOLDING' | 'INPUT' | 'COIL' | 'DISCRETE_INPUT';
  /** For bit-packed status words: which bit within the register carries this point. */
  bitOffset?: number;
}

export interface PointMapProfile {
  profileId: string;
  displayName: string;
  manufacturer: string;
  models: string[];
  /** Points keyed by protocol, because one relay often exposes different maps per protocol. */
  points: Partial<Record<SourceProtocolV2, PointDefinition[]>>;
}

export type PointMap = Record<string, PointMapProfile>;

/**
 * Built-in profiles. These are representative maps for the vendor families named in the spec, in
 * the shape a commissioning engineer would fill in from the relay manual. They ship as a starting
 * point; real sites override them (see docs/OPERATIONS_MANUAL.md §"Onboarding a relay").
 */
export const BUILT_IN_POINT_MAPS: PointMap = {
  'siemens-siprotec-generic': {
    profileId: 'siemens-siprotec-generic',
    displayName: 'Siemens SIPROTEC (generic)',
    manufacturer: 'Siemens',
    models: ['SIPROTEC 5 7SJ82', 'SIPROTEC 5 7SA82', 'SIPROTEC 4 7SJ64'],
    points: {
      IEC60870_5_104: [
        { address: 1, name: 'breaker_position', kind: 'BREAKER_POSITION' },
        { address: 100, name: 'current_A', kind: 'MEASUREMENT', scale: 1, unit: 'A' },
        { address: 101, name: 'voltage_kV', kind: 'MEASUREMENT', scale: 0.001, unit: 'kV' },
        { address: 102, name: 'frequency_Hz', kind: 'MEASUREMENT', scale: 0.01, unit: 'Hz' },
        { address: 200, name: 'overcurrent_pickup', kind: 'PROTECTION_PICKUP', protectionFunction: 'OVERCURRENT' },
        { address: 201, name: 'overcurrent_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'OVERCURRENT' },
        { address: 202, name: 'earth_fault_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'EARTH_FAULT' },
        { address: 300, name: 'device_alarm', kind: 'DEVICE_HEALTH' },
      ],
      MODBUS_TCP: [
        { address: 30001, name: 'current_A', kind: 'MEASUREMENT', scale: 0.1, unit: 'A', dataType: 'UINT32', registerTable: 'INPUT' },
        { address: 30003, name: 'voltage_kV', kind: 'MEASUREMENT', scale: 0.001, unit: 'kV', dataType: 'UINT32', registerTable: 'INPUT' },
        { address: 30005, name: 'frequency_Hz', kind: 'MEASUREMENT', scale: 0.01, unit: 'Hz', dataType: 'UINT16', registerTable: 'INPUT' },
        { address: 10001, name: 'breaker_position', kind: 'BREAKER_POSITION', dataType: 'BOOL', registerTable: 'DISCRETE_INPUT' },
        { address: 10010, name: 'trip_indication', kind: 'PROTECTION_TRIP', dataType: 'BOOL', registerTable: 'DISCRETE_INPUT', protectionFunction: 'OVERCURRENT' },
      ],
      IEC60870_5_103: [
        // IEC 103 uses standardised protection information numbers — the same INF means the same
        // thing across compliant vendors, which is what makes -103 unusually good for legacy fleets.
        { address: 84, name: 'general_start', kind: 'PROTECTION_PICKUP' },
        { address: 68, name: 'general_trip', kind: 'PROTECTION_TRIP' },
        { address: 90, name: 'trip_L1', kind: 'PROTECTION_TRIP', protectionFunction: 'OVERCURRENT' },
        { address: 91, name: 'trip_L2', kind: 'PROTECTION_TRIP', protectionFunction: 'OVERCURRENT' },
        { address: 92, name: 'trip_L3', kind: 'PROTECTION_TRIP', protectionFunction: 'OVERCURRENT' },
        { address: 93, name: 'trip_earth', kind: 'PROTECTION_TRIP', protectionFunction: 'EARTH_FAULT' },
        { address: 16, name: 'auto_reclose_active', kind: 'DEVICE_HEALTH' },
        { address: 19, name: 'led_reset', kind: 'DEVICE_HEALTH' },
      ],
    },
  },

  'abb-ref-generic': {
    profileId: 'abb-ref-generic',
    displayName: 'ABB / Hitachi Energy REF-REx (generic)',
    manufacturer: 'ABB',
    models: ['REF615', 'RET615', 'REL650', 'RED670', 'REC670', 'RET670'],
    points: {
      IEC60870_5_104: [
        { address: 1, name: 'breaker_position', kind: 'BREAKER_POSITION' },
        { address: 110, name: 'current_A', kind: 'MEASUREMENT', scale: 1, unit: 'A' },
        { address: 111, name: 'voltage_kV', kind: 'MEASUREMENT', scale: 0.001, unit: 'kV' },
        { address: 210, name: 'differential_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'TRANSFORMER_DIFFERENTIAL' },
        { address: 211, name: 'overcurrent_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'OVERCURRENT' },
      ],
      SPA_BUS: [
        { address: 1, name: 'current_A', kind: 'MEASUREMENT', scale: 1, unit: 'A' },
        { address: 2, name: 'breaker_position', kind: 'BREAKER_POSITION' },
        { address: 3, name: 'overcurrent_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'OVERCURRENT' },
      ],
      MODBUS_TCP: [
        { address: 40001, name: 'current_A', kind: 'MEASUREMENT', scale: 0.1, unit: 'A', dataType: 'UINT32', registerTable: 'HOLDING' },
        { address: 40003, name: 'voltage_kV', kind: 'MEASUREMENT', scale: 0.001, unit: 'kV', dataType: 'UINT32', registerTable: 'HOLDING' },
        { address: 40010, name: 'status_word', kind: 'BREAKER_POSITION', dataType: 'UINT16', registerTable: 'HOLDING', bitOffset: 0 },
      ],
    },
  },

  'schneider-micom-generic': {
    profileId: 'schneider-micom-generic',
    displayName: 'Schneider Electric MiCOM / Easergy (generic)',
    manufacturer: 'Schneider Electric',
    models: ['MiCOM P123', 'MiCOM P443', 'Easergy P3'],
    points: {
      MODBUS_TCP: [
        { address: 30016, name: 'current_A', kind: 'MEASUREMENT', scale: 0.01, unit: 'A', dataType: 'UINT32', registerTable: 'INPUT' },
        { address: 30020, name: 'voltage_kV', kind: 'MEASUREMENT', scale: 0.001, unit: 'kV', dataType: 'UINT32', registerTable: 'INPUT' },
        { address: 30024, name: 'frequency_Hz', kind: 'MEASUREMENT', scale: 0.01, unit: 'Hz', dataType: 'UINT16', registerTable: 'INPUT' },
        { address: 10001, name: 'breaker_position', kind: 'BREAKER_POSITION', dataType: 'BOOL', registerTable: 'DISCRETE_INPUT' },
        { address: 10005, name: 'overcurrent_trip', kind: 'PROTECTION_TRIP', dataType: 'BOOL', registerTable: 'DISCRETE_INPUT', protectionFunction: 'OVERCURRENT' },
        { address: 10006, name: 'earth_fault_trip', kind: 'PROTECTION_TRIP', dataType: 'BOOL', registerTable: 'DISCRETE_INPUT', protectionFunction: 'EARTH_FAULT' },
      ],
      COURIER: [
        { address: 0x0201, name: 'current_A', kind: 'MEASUREMENT', scale: 0.01, unit: 'A' },
        { address: 0x0801, name: 'general_trip', kind: 'PROTECTION_TRIP' },
      ],
    },
  },

  'sel-generic': {
    profileId: 'sel-generic',
    displayName: 'SEL (generic)',
    manufacturer: 'SEL',
    models: ['SEL-751', 'SEL-421', 'SEL-587Z'],
    points: {
      DNP3_TCP: [
        { address: 0, name: 'breaker_position', kind: 'BREAKER_POSITION' },
        { address: 1, name: 'overcurrent_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'OVERCURRENT' },
        { address: 2, name: 'earth_fault_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'EARTH_FAULT' },
        { address: 3, name: 'relay_trouble', kind: 'DEVICE_HEALTH' },
        { address: 0x1000, name: 'current_A', kind: 'MEASUREMENT', scale: 0.1, unit: 'A' },
        { address: 0x1001, name: 'voltage_kV', kind: 'MEASUREMENT', scale: 0.001, unit: 'kV' },
        { address: 0x1002, name: 'frequency_Hz', kind: 'MEASUREMENT', scale: 0.01, unit: 'Hz' },
      ],
      SEL_ASCII: [
        // SEL Fast Meter analogue channel positions, resolved by name from the METER response.
        { address: 0, name: 'current_A', kind: 'MEASUREMENT', unit: 'A' },
        { address: 1, name: 'voltage_kV', kind: 'MEASUREMENT', unit: 'kV' },
        { address: 2, name: 'frequency_Hz', kind: 'MEASUREMENT', unit: 'Hz' },
      ],
    },
  },

  'ge-multilin-generic': {
    profileId: 'ge-multilin-generic',
    displayName: 'GE Multilin (generic)',
    manufacturer: 'GE Multilin',
    models: ['GE F60', 'GE B90', 'GE 850'],
    points: {
      DNP3_TCP: [
        { address: 0, name: 'breaker_position', kind: 'BREAKER_POSITION' },
        { address: 4, name: 'busbar_differential_trip', kind: 'PROTECTION_TRIP', protectionFunction: 'BUSBAR_DIFFERENTIAL' },
        { address: 0x2000, name: 'current_A', kind: 'MEASUREMENT', scale: 0.1, unit: 'A' },
      ],
      MODBUS_TCP: [
        { address: 40001, name: 'current_A', kind: 'MEASUREMENT', scale: 0.1, unit: 'A', dataType: 'UINT32', registerTable: 'HOLDING' },
        { address: 40100, name: 'breaker_position', kind: 'BREAKER_POSITION', dataType: 'UINT16', registerTable: 'HOLDING', bitOffset: 0 },
      ],
      GE_EGD: [
        { address: 0, name: 'current_A', kind: 'MEASUREMENT', scale: 0.1, unit: 'A', dataType: 'FLOAT32' },
        { address: 4, name: 'breaker_position', kind: 'BREAKER_POSITION', dataType: 'BOOL' },
      ],
    },
  },
};

/** Resolve one address to its meaning, or undefined when the point is not mapped. */
export function resolvePoint(
  map: PointMap,
  profileId: string | undefined,
  protocol: SourceProtocolV2,
  address: number
): PointDefinition | undefined {
  if (!profileId) return undefined;
  const profile = map[profileId];
  if (!profile) return undefined;
  return profile.points[protocol]?.find((p) => p.address === address);
}

/** All points for a protocol on a profile — used by poll-mode drivers to build their read plan. */
export function pointsFor(
  map: PointMap,
  profileId: string | undefined,
  protocol: SourceProtocolV2
): PointDefinition[] {
  if (!profileId) return [];
  return map[profileId]?.points[protocol] ?? [];
}

/** Pick a sensible default profile for a relay when the site has not assigned one explicitly. */
export function defaultProfileForManufacturer(manufacturer: string): string | undefined {
  const entry = Object.values(BUILT_IN_POINT_MAPS).find(
    (p) => p.manufacturer.toLowerCase() === manufacturer.toLowerCase()
  );
  if (entry) return entry.profileId;
  // Hitachi Energy relays are the ABB REx lineage.
  if (/hitachi/i.test(manufacturer)) return 'abb-ref-generic';
  return undefined;
}
