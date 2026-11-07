/**
 * Main-side event bus: services emit typed domain events; the window manager forwards them to renderers
 * (webContents.send(EVENT_CHANNEL, domain, event, payload)). Pure, so services are testable without Electron.
 */
import type { Domain, S12Events, WindowKind } from '../shared/api';

export type EventSink = (domain: Domain, event: string, payload: unknown, to?: WindowKind) => void;

export class EventBus {
  private sinks = new Set<EventSink>();

  /** Attach a sink (the window manager, a test recorder). */
  attach(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** Emit to every window, or only to windows of kind `to`. */
  emit<D extends Domain, E extends keyof S12Events[D] & string>(domain: D, event: E, payload: S12Events[D][E], to?: WindowKind): void {
    for (const s of [...this.sinks]) s(domain, event, payload, to);
  }

  /** Untyped emit for relayed worker events (already shaped by the worker). */
  emitRaw(domain: Domain, event: string, payload: unknown, to?: WindowKind): void {
    for (const s of [...this.sinks]) s(domain, event, payload, to);
  }
}
