/**
 * SCI transmit history per channel, buffered from window load so the Terminal shows what the program printed before
 * the component was opened (hiwave's virtual SCI keeps a cache too). 64 KiB per channel.
 */
import type { S12Api } from '../../../../shared/api';

const MAX = 64 * 1024;

type Listener = (channel: number, data: Uint8Array) => void;

export class SciBuffer {
  private chunks = new Map<number, number[]>();
  private listeners = new Set<Listener>();

  constructor(api: S12Api) {
    api.debug.on('sciOutput', ({ channel, data }) => this.push(channel, data));
  }

  push(channel: number, data: readonly number[]): void {
    let buf = this.chunks.get(channel);
    if (!buf) this.chunks.set(channel, (buf = []));
    buf.push(...data);
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    const bytes = Uint8Array.from(data);
    for (const l of [...this.listeners]) l(channel, bytes);
  }

  history(channel: number): Uint8Array {
    return Uint8Array.from(this.chunks.get(channel) ?? []);
  }

  clear(channel: number): void {
    this.chunks.delete(channel);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

const buffers = new WeakMap<S12Api, SciBuffer>();

export function sciBufferFor(api: S12Api): SciBuffer {
  let b = buffers.get(api);
  if (!b) buffers.set(api, (b = new SciBuffer(api)));
  return b;
}

try {
  const api = (globalThis as { s12?: S12Api }).s12;
  if (api?.debug?.on) sciBufferFor(api);
} catch {
  /* not in Electron */
}
