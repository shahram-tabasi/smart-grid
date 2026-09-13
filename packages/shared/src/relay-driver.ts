import { UnifiedEvent } from './unified-event';
import { CommStatus, SourceProtocol } from './enums';

/**
 * The vendor-neutral contract every protocol driver in the Edge Gateway implements.
 * See docs/ARCHITECTURE.md §6. Deliberately: there is no write/setSetting/control/tripBreaker method
 * anywhere on this interface. Phase 1-8 as scoped are monitoring-only; adding control is an explicit,
 * separate, future architectural decision — not a method you can just add here.
 */
export interface RelayEndpoint {
  relayId: string;
  host: string;
  port: number;
  protocol: SourceProtocol;
  credentialsRef: string; // reference into the credential vault — never a raw secret in this object
}

export interface RelayStatusSnapshot {
  commStatus: CommStatus;
  breakerStatus: string;
  activeSettingGroup: string;
  measurements: Record<string, number>;
  lastUpdated: string;
}

export type Unsubscribe = () => void;

export interface RelayDriver {
  readonly protocol: SourceProtocol;
  connect(target: RelayEndpoint): Promise<void>;
  disconnect(target: RelayEndpoint): Promise<void>;
  readStatus(target: RelayEndpoint): Promise<RelayStatusSnapshot>;
  subscribeEvents(target: RelayEndpoint, onEvent: (e: UnifiedEvent) => void): Unsubscribe;
}
