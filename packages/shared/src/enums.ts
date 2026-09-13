// Mirrors db/migrations/001_extensions_and_enums.sql — keep these two files in sync by hand;
// see db/seed/README for the (small, deliberate) reasons this isn't code-generated in Phase 1.

export const USER_ROLES = [
  'ADMIN', 'EXECUTIVE', 'PROJECT_MANAGER', 'TECHNICAL_MANAGER',
  'PROTECTION_ENGINEER', 'FIELD_SERVICE_ENGINEER', 'VIEWER',
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PROJECT_STATUSES = [
  'PLANNING', 'ENGINEERING', 'PROCUREMENT', 'MANUFACTURING', 'FAT',
  'INSTALLATION', 'COMMISSIONING', 'RUNNING', 'COMPLETED', 'BLOCKED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TYPES = [
  'MV_SWITCHGEAR', 'HV_SWITCHGEAR', 'SUBSTATION_TURNKEY', 'RELAY_UPGRADE',
  'SCADA_INTEGRATION', 'PANEL_MANUFACTURING', 'OTHER',
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const COMM_STATUSES = ['ONLINE', 'OFFLINE', 'DEGRADED', 'UNKNOWN'] as const;
export type CommStatus = (typeof COMM_STATUSES)[number];

export const RELAY_HEALTH_STATUSES = ['HEALTHY', 'WARNING', 'ATTENTION', 'CRITICAL', 'OFFLINE'] as const;
export type RelayHealthStatus = (typeof RELAY_HEALTH_STATUSES)[number];

export const BREAKER_STATUSES = ['OPEN', 'CLOSED', 'TRIPPED', 'UNKNOWN'] as const;
export type BreakerStatus = (typeof BREAKER_STATUSES)[number];

export const EVENT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export const PROTECTION_FUNCTIONS = [
  'OVERCURRENT', 'EARTH_FAULT', 'SHORT_CIRCUIT', 'OVERVOLTAGE', 'UNDERVOLTAGE',
  'OVERFREQUENCY', 'UNDERFREQUENCY', 'TRANSFORMER_DIFFERENTIAL', 'BUSBAR_DIFFERENTIAL',
  'BREAKER_FAILURE', 'NEGATIVE_SEQUENCE', 'THERMAL_OVERLOAD', 'MOTOR_PROTECTION',
  'DISTANCE_PROTECTION', 'DIRECTIONAL_OVERCURRENT', 'LOSS_OF_VOLTAGE', 'LOSS_OF_CURRENT',
  'TRIP_CIRCUIT_FAILURE',
] as const;
export type ProtectionFunctionCode = (typeof PROTECTION_FUNCTIONS)[number];

export const PROTECTION_FUNCTION_ANSI: Record<ProtectionFunctionCode, string> = {
  OVERCURRENT: '50/51',
  EARTH_FAULT: '50N/51N',
  SHORT_CIRCUIT: '50HS',
  OVERVOLTAGE: '59',
  UNDERVOLTAGE: '27',
  OVERFREQUENCY: '81O',
  UNDERFREQUENCY: '81U',
  TRANSFORMER_DIFFERENTIAL: '87T',
  BUSBAR_DIFFERENTIAL: '87B',
  BREAKER_FAILURE: '50BF',
  NEGATIVE_SEQUENCE: '46',
  THERMAL_OVERLOAD: '49',
  MOTOR_PROTECTION: '49M/50M',
  DISTANCE_PROTECTION: '21',
  DIRECTIONAL_OVERCURRENT: '67',
  LOSS_OF_VOLTAGE: '27/LOV',
  LOSS_OF_CURRENT: 'LOC',
  TRIP_CIRCUIT_FAILURE: '74TCS',
};

export const SOURCE_PROTOCOLS = [
  'IEC61850_MMS', 'IEC61850_GOOSE', 'IEC60870_5_104', 'DNP3', 'MODBUS_TCP', 'OPC_UA', 'REST', 'MQTT', 'SYNTHETIC',
] as const;
export type SourceProtocol = (typeof SOURCE_PROTOCOLS)[number];

export const FAULT_TRIP_STATUSES = ['TRIPPED', 'NO_TRIP', 'ALARM_ONLY'] as const;
export type FaultTripStatus = (typeof FAULT_TRIP_STATUSES)[number];

export const ACK_STATUSES = ['UNACKNOWLEDGED', 'ACKNOWLEDGED', 'AUTO_ACKNOWLEDGED'] as const;
export type AckStatus = (typeof ACK_STATUSES)[number];

export const ROOT_CAUSE_STATUSES = ['PENDING', 'AI_SUGGESTED', 'ENGINEER_CONFIRMED', 'INCONCLUSIVE'] as const;
export type RootCauseStatus = (typeof ROOT_CAUSE_STATUSES)[number];

export const FAULT_RESOLUTION_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED_NO_ACTION'] as const;
export type FaultResolutionStatus = (typeof FAULT_RESOLUTION_STATUSES)[number];

export const ALARM_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type AlarmPriority = (typeof ALARM_PRIORITIES)[number];

export const ALARM_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'SUPPRESSED', 'CLOSED'] as const;
export type AlarmStatus = (typeof ALARM_STATUSES)[number];

export const WORK_ORDER_STATUSES = [
  'OPEN', 'ANALYSIS', 'ASSIGNED', 'FIELD_INSPECTION', 'REPAIR', 'TEST', 'VERIFIED', 'CLOSED',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const WORK_ORDER_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

export const RELAY_MANUFACTURERS = [
  'Siemens', 'ABB', 'Hitachi Energy', 'Schneider Electric', 'SEL', 'GE Multilin', 'Other',
] as const;
export type RelayManufacturer = (typeof RELAY_MANUFACTURERS)[number];

export const RELAY_MODELS_BY_MANUFACTURER: Record<RelayManufacturer, string[]> = {
  Siemens: ['SIPROTEC 5 7SJ82', 'SIPROTEC 5 7SA82', 'SIPROTEC 4 7SJ64'],
  ABB: ['REF615', 'RET615', 'REL650'],
  'Hitachi Energy': ['RED670', 'REC670', 'RET670'],
  'Schneider Electric': ['MiCOM P123', 'MiCOM P443', 'Easergy P3'],
  SEL: ['SEL-751', 'SEL-421', 'SEL-587Z'],
  'GE Multilin': ['GE F60', 'GE B90', 'GE 850'],
  Other: ['Generic IEC 61850 IED'],
};
