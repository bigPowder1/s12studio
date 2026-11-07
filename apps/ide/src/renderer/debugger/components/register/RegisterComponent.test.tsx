import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMockS12 } from '../../../common/testing/mockS12';
import { S12Provider } from '../../../common/s12';
import { ComponentHostContext, type ComponentHost } from '../contract';
import { snapshot } from '../../shell/testing';
import { RegisterComponent } from './RegisterComponent';
import { formatReg, parseReg, valueWidthCh } from './model';

function setup(attributes = [{ name: 'FORMAT', value: 'AUTO' }]) {
  const m = createMockS12();
  const headlines: string[] = [];
  const menus: unknown[] = [];
  const host: ComponentHost = { setMenu: (i) => menus.push(i), setHeadline: (t) => headlines.push(t), open: () => undefined, activate: () => undefined, onUiCommand: () => () => undefined };
  render(
    <S12Provider api={m.api}>
      <ComponentHostContext.Provider value={host}>
        <RegisterComponent instanceId="w1" title="Register" instance={1} attributes={attributes} active />
      </ComponentHostContext.Provider>
    </S12Provider>,
  );
  return { m, headlines, menus };
}

describe('RegisterComponent', () => {
  it('paints registers that changed since the previous halt red (not the CCR bits)', () => {
    const { m, headlines } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ cycles: 2 })));
    expect(screen.getByTestId('reg-PC')).toHaveTextContent('C000');
    expect(screen.getByTestId('reg-X')).toHaveTextContent('0000');
    act(() => m.emit('debug', 'snapshot', snapshot({ state: 'running' })));
    act(() => m.emit('debug', 'snapshot', snapshot({ cycles: 9, regs: { PC: 0xc003, A: 0x12, D: 0x1200, CCR: 0xd4 } })));
    expect(screen.getByTestId('reg-PC')).toHaveTextContent('C003');
    expect(screen.getByTestId('reg-PC')).toHaveClass('changed');
    expect(screen.getByTestId('reg-A')).toHaveClass('changed');
    expect(screen.getByTestId('reg-D')).toHaveTextContent('1200');
    expect(screen.getByTestId('reg-B')).not.toHaveClass('changed');
    expect(screen.getByTestId('reg-SP')).not.toHaveClass('changed');
    // CCR bits: set = dark, clear = grey; never red
    expect(screen.getByTestId('ccr-Z')).not.toHaveClass('clear');
    expect(screen.getByTestId('ccr-C')).toHaveClass('clear');
    expect(screen.getByTestId('ccr-Z').className).not.toMatch(/changed/);
    expect(headlines.at(-1)).toMatch(/^HC12 {2}CPU Cycles: 9/);
  });

  it('edits a register in place: double-click, type, Enter -> debug.writeRegister', () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot()));
    fireEvent.doubleClick(screen.getByTestId('reg-X'));
    const input = screen.getByTestId('reg-edit-X') as HTMLInputElement;
    expect(input.value).toBe('0000');
    fireEvent.change(input, { target: { value: '1234' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(m.calls('debug', 'writeRegister')).toEqual([['X', 0x1234]]);
    expect(screen.queryByTestId('reg-edit-X')).toBeNull();
  });

  it('an unchanged edit of a hex value that looks binary (0B10) writes the same value back', () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { X: 0x0b10 } })));
    fireEvent.doubleClick(screen.getByTestId('reg-X'));
    const input = screen.getByTestId('reg-edit-X') as HTMLInputElement;
    expect(input.value).toBe('0B10');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(m.calls('debug', 'writeRegister')).toEqual([['X', 0x0b10]]);
  });

  it('Esc cancels, Tab commits and moves to the next register, bad input is refused', () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot()));
    fireEvent.doubleClick(screen.getByTestId('reg-A'));
    fireEvent.keyDown(screen.getByTestId('reg-edit-A'), { key: 'Escape' });
    expect(screen.queryByTestId('reg-edit-A')).toBeNull();
    fireEvent.doubleClick(screen.getByTestId('reg-A'));
    fireEvent.change(screen.getByTestId('reg-edit-A'), { target: { value: 'ZZ' } });
    fireEvent.keyDown(screen.getByTestId('reg-edit-A'), { key: 'Enter' });
    expect(m.calls('debug', 'writeRegister')).toEqual([]);
    fireEvent.change(screen.getByTestId('reg-edit-A'), { target: { value: '$7F' } });
    fireEvent.keyDown(screen.getByTestId('reg-edit-A'), { key: 'Tab' });
    expect(m.calls('debug', 'writeRegister')).toEqual([['A', 0x7f]]);
    expect(screen.getByTestId('reg-edit-B')).toBeInTheDocument();
  });

  it('toggles a CCR bit on double-click', () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { CCR: 0xd0 } })));
    fireEvent.doubleClick(screen.getByTestId('ccr-C'));
    fireEvent.doubleClick(screen.getByTestId('ccr-I'));
    expect(m.calls('debug', 'writeRegister')).toEqual([
      ['CCR', 0xd1],
      ['CCR', 0xc0],
    ]);
  });

  it('honours the FORMAT attribute and offers the format menu', () => {
    const { m, menus } = setup([{ name: 'FORMAT', value: 'DEC' }]);
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { A: 0xff, SP: 0x2400 } })));
    expect(screen.getByTestId('reg-A')).toHaveTextContent('-1');
    expect(screen.getByTestId('reg-SP')).toHaveTextContent('9216');
    const items = menus.at(-1) as { label: string; checked?: boolean }[];
    expect(items.map((i) => i.label.replace('&', ''))).toEqual(['Hex', 'Bin', 'Oct', 'Dec', 'UDec', 'Auto', 'Bit Reverse']);
    expect(items.find((i) => i.checked)?.label).toBe('&Dec');
    // grid columns sized (in ch, so they scale with the font) for the widest value of the format
    expect(screen.getByTestId('register-component').style.getPropertyValue('--reg-val-ch')).toBe('6');
    act(() => (items.find((i) => i.label === '&Bin') as unknown as { onSelect: () => void }).onSelect());
    expect(screen.getByTestId('register-component').style.getPropertyValue('--reg-val-ch')).toBe('17');
  });

  it('value widths per format', () => {
    expect([valueWidthCh('hex'), valueWidthCh('bin'), valueWidthCh('oct'), valueWidthCh('dec'), valueWidthCh('udec')]).toEqual([4, 17, 6, 6, 5]);
  });
});

describe('register formats', () => {
  it('formats and parses in every display format', () => {
    expect(formatReg(0xa5, 'auto', 8)).toBe('A5');
    expect(formatReg(0x1234, 'bin', 16)).toBe('00010010 00110100');
    expect(formatReg(0xfffe, 'dec', 16)).toBe('-2');
    expect(formatReg(0xfffe, 'udec', 16)).toBe('65534');
    expect(parseReg('-2', 'dec', 16)).toBe(0xfffe);
    expect(parseReg('1010', 'bin', 8)).toBe(10);
    expect(parseReg('0x10', 'dec', 8)).toBe(16);
    expect(parseReg('100', 'hex', 8)).toBeNull();
    expect(parseReg('377', 'oct', 8)).toBe(255);
    // review finding 1: bare hex digits are hex in the hex formats, never 0b/0o prefixed numbers
    expect(parseReg('0B10', 'hex', 16)).toBe(0x0b10);
    expect(parseReg('0b11', 'auto', 16)).toBe(0x0b11);
    expect(parseReg('0B00', 'auto', 16)).toBe(0x0b00);
    expect(parseReg('0b', 'hex', 8)).toBe(0x0b);
    expect(parseReg('0b101', 'dec', 8)).toBe(5);
    expect(parseReg('%101', 'hex', 8)).toBe(5);
    expect(parseReg('@17', 'hex', 8)).toBe(15);
    expect(parseReg('10h', 'dec', 8)).toBe(16);
  });

  it('every value round-trips through its display text in every format', () => {
    for (const fmt of ['auto', 'hex', 'bin', 'oct', 'dec', 'udec', 'bitrev'] as const) {
      for (const bits of [8, 16] as const) {
        const bad: number[] = [];
        for (let v = 0; v < 2 ** bits; v++) if (parseReg(formatReg(v, fmt, bits), fmt, bits) !== v) bad.push(v);
        expect({ fmt, bits, bad: bad.slice(0, 5) }).toEqual({ fmt, bits, bad: [] });
      }
    }
  });

  it('right-click offers the Format items (final fidelity F10)', () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot()));
    fireEvent.contextMenu(screen.getByTestId('reg-PC'));
    const bin = document.querySelector('[data-menu-id="register.format.bin"]') as HTMLElement;
    expect(bin).not.toBeNull();
    fireEvent.click(bin);
    expect(screen.getByTestId('reg-A').textContent).toMatch(/^[01]{8}$/);
  });
});
