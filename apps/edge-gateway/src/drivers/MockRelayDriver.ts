import { RelayDriver, RelayEndpoint, RelayStatusSnapshot, UnifiedEvent, Unsubscribe } from '@simorgh/shared';

/**
 * Reference driver implementing the RelayDriver contract (see packages/shared/src/relay-driver.ts)
 * without any real network connection. This is what makes the whole platform demonstrable before a
 * real site is connected (spec §33). A real driver — e.g. SiprotecMmsDriver, SelDnp3Driver — implements
 * exactly this interface and nothing upstream (Edge Gateway core, backend, frontend) needs to change.
 *
 * Notice what ISN'T here: no write/setSetting/control/tripBreaker method. That's enforced by the
 * RelayDriver interface itself, not a convention this class happens to follow.
 */
export class MockRelayDriver implements RelayDriver {
  readonly protocol = 'MQTT' as const;
  private timers = new Map<string, NodeJS.Timeout>();

  async connect(target: RelayEndpoint): Promise<void> {
    console.log(`[MockRelayDriver] connected (simulated) to ${target.relayId} at ${target.host}:${target.port}`);
  }

  async disconnect(target: RelayEndpoint): Promise<void> {
    const t = this.timers.get(target.relayId);
    if (t) clearInterval(t);
    this.timers.delete(target.relayId);
  }

  async readStatus(_target: RelayEndpoint): Promise<RelayStatusSnapshot> {
    return {
      commStatus: 'ONLINE',
      breakerStatus: 'CLOSED',
      activeSettingGroup: 'Group 1',
      measurements: { current_A: 120 + Math.random() * 30, voltage_kV: 33 + Math.random(), frequency_Hz: 50 + (Math.random() - 0.5) * 0.1 },
      lastUpdated: new Date().toISOString(),
    };
  }

  subscribeEvents(target: RelayEndpoint, onEvent: (e: UnifiedEvent) => void): Unsubscribe {
    const timer = setInterval(() => {
      onEvent({
        eventId: `mock-${target.relayId}-${Date.now()}`,
        timestamp: new Date().toISOString(),
        projectId: 'mock-project',
        provinceId: 'IR-THR',
        cityId: 'city_tehran',
        relayId: target.relayId,
        eventType: 'MEASUREMENT',
        severity: 'INFO',
        sourceProtocol: 'SYNTHETIC',
        message: `Simulated measurement update from ${target.relayId}`,
        measurements: { current_A: 100 + Math.random() * 50 },
        synthetic: true,
      });
    }, 15000);
    this.timers.set(target.relayId, timer);
    return () => clearInterval(timer);
  }
}
