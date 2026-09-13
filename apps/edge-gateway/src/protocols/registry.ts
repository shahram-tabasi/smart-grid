import {
  RelayDriverV2,
  SourceProtocolV2,
  PROTOCOL_CATALOGUE,
  CommPath,
  RelayCommProfile,
} from '@simorgh/shared';
import { PointMap, BUILT_IN_POINT_MAPS } from './pointMap';
import { Iec104Driver } from './iec60870/Iec104Driver';
import { Iec101Driver, Iec103Driver } from './iec60870/SerialIecDrivers';
import {
  Iec61850MmsDriver,
  Iec61850GooseDriver,
  Iec61850SvDriver,
  SimulatorIec61850Adapter,
  loadNativeAdapter,
  Iec61850Adapter,
} from './iec61850/Iec61850Drivers';
import { Dnp3Driver } from './dnp3/Dnp3Driver';
import { ModbusDriver } from './modbus/ModbusDriver';
import { OpcUaDriver, MqttDriver, RestDriver, WebSocketStreamDriver } from './modern/ModernDrivers';
import { SelAsciiDriver, SpaBusDriver, CourierDriver, GeEgdDriver, ProfibusDriver } from './vendor/VendorDrivers';
import { SnmpDriver, SyslogDriver, FileRetrievalDriver, TimeSyncDriver } from './auxiliary/AuxiliaryDrivers';
import { MockRelayDriver } from '../drivers/MockRelayDriver';

/**
 * The driver registry: one place that knows how to build a driver for every protocol in the
 * catalogue. Adding a protocol means adding a catalogue entry and a factory line here — nothing in
 * the supervisor, the API or the UI needs to change.
 */

export interface RegistryOptions {
  /**
   * Run every driver against simulated data instead of real hardware. This is what the demo and
   * the test suite use, and it is the default: a gateway must never be assumed to be pointed at a
   * live substation unless someone explicitly said so.
   */
  simulate: boolean;
  pointMap?: PointMap;
  iec61850Adapter?: Iec61850Adapter;
}

export class DriverRegistry {
  private drivers = new Map<SourceProtocolV2, RelayDriverV2>();
  private pointMap: PointMap;
  private adapter: Iec61850Adapter;

  constructor(private options: RegistryOptions) {
    this.pointMap = options.pointMap ?? BUILT_IN_POINT_MAPS;
    // Prefer an explicitly supplied adapter, then a configured native stack, then the simulator.
    this.adapter =
      options.iec61850Adapter ??
      (options.simulate ? new SimulatorIec61850Adapter() : loadNativeAdapter() ?? new SimulatorIec61850Adapter());
  }

  /** Build (and cache) the driver for a protocol. */
  get(protocol: SourceProtocolV2): RelayDriverV2 {
    const existing = this.drivers.get(protocol);
    if (existing) return existing;

    const sim = { simulate: this.options.simulate };
    let driver: RelayDriverV2;

    switch (protocol) {
      case 'IEC61850_MMS':
      case 'IEC61850_FILE':
        driver = new Iec61850MmsDriver(this.adapter);
        break;
      case 'IEC61850_GOOSE':
        driver = new Iec61850GooseDriver(this.adapter);
        break;
      case 'IEC61850_SV':
        driver = new Iec61850SvDriver(this.adapter);
        break;

      case 'IEC60870_5_104':
        driver = new Iec104Driver(this.pointMap, sim);
        break;
      case 'IEC60870_5_101':
        driver = new Iec101Driver(this.pointMap, sim);
        break;
      case 'IEC60870_5_103':
        driver = new Iec103Driver(this.pointMap, sim);
        break;

      case 'DNP3_TCP':
      case 'DNP3_SERIAL':
        driver = new Dnp3Driver(this.pointMap, protocol, sim);
        break;

      case 'MODBUS_TCP':
      case 'MODBUS_RTU':
      case 'MODBUS_ASCII':
        driver = new ModbusDriver(this.pointMap, protocol, sim);
        break;

      case 'OPC_UA':
        driver = new OpcUaDriver(sim);
        break;
      case 'MQTT':
      case 'MQTT_SPARKPLUG_B':
        driver = new MqttDriver(protocol, sim);
        break;
      case 'REST':
        driver = new RestDriver(sim);
        break;
      case 'WEBSOCKET':
        driver = new WebSocketStreamDriver(sim);
        break;

      case 'SEL_ASCII':
        driver = new SelAsciiDriver(sim);
        break;
      case 'SPA_BUS':
        driver = new SpaBusDriver(sim);
        break;
      case 'COURIER':
        driver = new CourierDriver(sim);
        break;
      case 'GE_EGD':
        driver = new GeEgdDriver(sim);
        break;
      case 'PROFIBUS_DP':
        driver = new ProfibusDriver(sim);
        break;

      case 'SNMP':
        driver = new SnmpDriver(sim);
        break;
      case 'SYSLOG':
        driver = new SyslogDriver(sim);
        break;
      case 'FTP':
      case 'SFTP':
      case 'TFTP':
        driver = new FileRetrievalDriver(protocol, sim);
        break;
      case 'NTP':
      case 'PTP_1588':
        driver = new TimeSyncDriver(protocol, sim);
        break;

      case 'SYNTHETIC':
      default:
        driver = new MockRelayDriver() as unknown as RelayDriverV2;
        break;
    }

    this.drivers.set(protocol, driver);
    return driver;
  }

  /** Every protocol that has been instantiated, for the health endpoint. */
  activeProtocols(): SourceProtocolV2[] {
    return [...this.drivers.keys()];
  }

  /**
   * Validate a path before the supervisor tries to use it. Catching a misconfiguration here gives
   * a clear message in the admin UI instead of a mystifying connection failure at 3am.
   */
  static validatePath(path: CommPath, profile: RelayCommProfile): string[] {
    const problems: string[] = [];
    const descriptor = PROTOCOL_CATALOGUE[path.protocol];
    if (!descriptor) {
      problems.push(`Unknown protocol "${path.protocol}".`);
      return problems;
    }

    const needsHost = ['TCP', 'UDP'].includes(descriptor.transport);
    const needsSerial = descriptor.transport.startsWith('SERIAL');

    if (needsHost && !path.host) problems.push(`${descriptor.displayName} needs a host address.`);
    if (needsSerial && !path.serial) problems.push(`${descriptor.displayName} needs serial port settings.`);
    if (descriptor.transport === 'ETHERNET_LAYER2' && !path.addressing?.networkInterface) {
      problems.push(
        `${descriptor.displayName} is layer-2 multicast and needs addressing.networkInterface set to the station-bus interface.`
      );
    }
    if (descriptor.deliveryMode === 'POLL' && !path.pollIntervalMs) {
      problems.push(`${descriptor.displayName} is poll-based; set pollIntervalMs on the path.`);
    }
    if (!path.supervisionTimeoutSec || path.supervisionTimeoutSec <= 0) {
      problems.push('supervisionTimeoutSec must be greater than zero so link loss is detectable.');
    }

    // A relay whose only path is Modbus can miss short trips entirely — worth flagging at config
    // time rather than discovering it after a missed event.
    if (
      profile.paths.length === 1 &&
      descriptor.family === 'MODBUS' &&
      !descriptor.capabilities.sequenceOfEvents
    ) {
      problems.push(
        `Warning: ${profile.relayCode} has only a Modbus path. Modbus has no event buffer, so a trip shorter than the poll interval can be missed. Add a protection-grade path (IEC 61850, IEC 60870-5-103 or DNP3) where the relay supports one.`
      );
    }
    if (descriptor.family === 'MODBUS' && !profile.pointMapProfileId) {
      problems.push(`${profile.relayCode} uses ${descriptor.displayName} but has no point-map profile assigned; no data can be interpreted.`);
    }
    return problems;
  }
}
