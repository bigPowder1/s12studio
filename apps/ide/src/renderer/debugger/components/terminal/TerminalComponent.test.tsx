import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S12Provider } from '../../../common/s12';
import { createMockS12 } from '../../../common/testing/mockS12';

// jsdom cannot render xterm.js (canvas, measurements): a recording fake with the API the component uses.
const terms: FakeTerminal[] = [];
class FakeTerminal {
  written: string[] = [];
  options: Record<string, unknown>;
  dataListener: ((d: string) => void) | null = null;
  disposed = false;
  constructor(opts: Record<string, unknown>) {
    this.options = { ...opts };
    terms.push(this);
  }
  loadAddon() {}
  open() {}
  onData(l: (d: string) => void) {
    this.dataListener = l;
    return { dispose: () => (this.dataListener = null) };
  }
  write(d: string | Uint8Array) {
    this.written.push(typeof d === 'string' ? d : new TextDecoder().decode(d));
  }
  reset() {
    this.written = [];
  }
  getSelection() {
    return '';
  }
  paste() {}
  focus() {}
  dispose() {
    this.disposed = true;
  }
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const { TerminalComponent, encodeInput } = await import('./TerminalComponent');
const { sciBufferFor } = await import('./sciBuffer');

function setup() {
  const m = createMockS12();
  sciBufferFor(m.api);
  m.emit('debug', 'sciOutput', { channel: 0, data: [...'boot\n'].map((c) => c.charCodeAt(0)) });
  render(
    <S12Provider api={m.api}>
      <TerminalComponent instanceId="Terminal" title="Terminal" instance={1} attributes={[]} active />
    </S12Provider>,
  );
  return m;
}

describe('TerminalComponent', () => {
  beforeEach(() => {
    terms.length = 0;
    localStorage.clear();
  });

  it('replays SCI0 history, streams new output of the selected channel only', async () => {
    const m = setup();
    const t = terms[0];
    expect(t.written.join('')).toBe('boot\n');
    await act(async () => m.emit('debug', 'sciOutput', { channel: 0, data: [0x48, 0x69] }));
    await act(async () => m.emit('debug', 'sciOutput', { channel: 1, data: [0x58] }));
    expect(t.written.join('')).toBe('boot\nHi');
  });

  it('sends keystrokes to the SCI receiver (Enter = CR by default)', async () => {
    const m = setup();
    act(() => terms[0].dataListener!('a\r'));
    await waitFor(() => expect(m.calls('debug', 'sciSend')).toEqual([[0, [0x61, 0x0d]]]));
    expect(encodeInput('\r', 'crlf')).toEqual([0x0d, 0x0a]);
  });

  it('switches channel in Configure Connections and clears', async () => {
    const m = setup();
    fireEvent.contextMenu(screen.getByTestId('terminal-component'));
    fireEvent.click(document.querySelector('[data-menu-id="terminal.configure"]')!);
    fireEvent.change(screen.getByLabelText('SCI channel'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('terminal-config-ok'));
    await act(async () => m.emit('debug', 'sciOutput', { channel: 1, data: [0x31] }));
    expect(terms[0].written.join('')).toBe('1');
    act(() => terms[0].dataListener!('x'));
    await waitFor(() => expect(m.calls('debug', 'sciSend')).toEqual([[1, [0x78]]]));
    fireEvent.contextMenu(screen.getByTestId('terminal-component'));
    fireEvent.click(document.querySelector('[data-menu-id="terminal.clear"]')!);
    expect(terms[0].written).toEqual([]);
  });
});
