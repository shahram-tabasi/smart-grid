import { EventSeverity, BreakerStatus, ProtectionFunctionCode, SourceProtocol } from './enums';
import { SourceProtocolV2, TimeSyncQuality } from './protocols';

/**
 * The Unified Event Model. Every event that reaches Kafka / the database is shaped exactly like this,
 * regardless of which relay manufacturer or protocol produced it. See docs/ARCHITECTURE.md §7.
 *
 * Deliberately absent: any latitude/longitude/address field. Only provinceId/cityId travel with an event.
 */

/**
 * Phase 1 shipped a narrow protocol enum; Phase 2 widened it to the full catalogue in protocols.ts.
 * Both are accepted so events already stored under the Phase 1 vocabulary (notably the legacy plain
 * 'DNP3', now split into DNP3_TCP/DNP3_SERIAL) still typecheck and still parse.
 */
export type AnySourceProtocol = SourceProtocol | SourceProtocolV2;

export interface UnifiedEvent {
  eventId: string;
  timestamp: string; // ISO 8601, millisecond precision
  projectId: string;
  provinceId: string;
  cityId: string;
  panelId?: string;
  assetId?: string;
  relayId?: string;
  eventType:
    | 'PROTECTION_PICKUP'
    | 'PROTECTION_TRIP'
    | 'BREAKER_STATE_CHANGE'
    | 'COMM_LOST'
    | 'COMM_RESTORED'
    | 'SCADA_ALARM'
    | 'ENGINEER_NOTIFIED'
    | 'MEASUREMENT'
    | 'SETTING_GROUP_CHANGE_DETECTED'
    // Phase 2 additions — all still observation-only event types.
    | 'DISTURBANCE_RECORD_AVAILABLE'
    | 'DEVICE_SELF_TEST_FAILED'
    | 'TIME_SYNC_DEGRADED'
    | 'SECURITY_LOG_EVENT'
    | 'GOOSE_SEQUENCE_ANOMALY';
  protectionFunction?: ProtectionFunctionCode;
  severity: EventSeverity;
  breakerStatus?: BreakerStatus;
  sourceProtocol: AnySourceProtocol;
  message: string;
  measurements?: {
    current_A?: number;
    voltage_kV?: number;
    frequency_Hz?: number;
    [key: string]: number | undefined;
  };
  acknowledged?: boolean;
  synthetic: boolean; // true for all demo/generated data — never omit this for real field data either (explicit false)

  // --- Phase 2 provenance ---------------------------------------------------------------------
  /**
   * How much the `timestamp` above can be trusted. A Modbus-derived event is gateway-stamped and
   * must not be presented as equal in precision to a GOOSE message from a PTP-synced station.
   * The fault timeline uses this to order and caveat entries honestly.
   */
  timeSyncQuality?: TimeSyncQuality;
  /** Which configured communication path produced this event (see CommPath.pathId). */
  sourcePathId?: string;
  /** Raw protocol-level reference, kept for engineer drill-down: IEC 103 INF number, DNP3 point index, etc. */
  sourceReference?: string;
}
