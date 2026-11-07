import { describe, it, expect } from 'vitest';
import { PinNet, SpiBus, createBoardNets } from '@s12/sim';

describe('PinNet', () => {
  it('resolves board > periph > gpio > pull > floating', () => {
    const n = new PinNet();
    expect(n.read('PJ7')).toBe(1);
    n.setPull('PJ7', 'down');
    expect(n.read('PJ7')).toBe(0);
    n.setMcuOutput('PJ7', 1);
    expect(n.read('PJ7')).toBe(1);
    n.setMcuOutput('PJ7', 0, 'periph');
    expect(n.read('PJ7')).toBe(0);
    expect(n.state('PJ7').mcuLayer).toBe('periph');
    n.drive('PJ7', 1);
    expect(n.read('PJ7')).toBe(1);
    n.drive('PJ7', null);
    n.setMcuOutput('PJ7', null, 'periph');
    expect(n.read('PJ7')).toBe(1);
  });
  it('notifies listeners with cycle and supports byte helpers', () => {
    const n = new PinNet();
    let cyc = 42;
    n.now = () => cyc;
    const seen: Array<[string, number, number]> = [];
    n.on('PM6', (p, s, c) => seen.push([p, s.level, c]));
    n.setMcuOutput('PM6', 0);
    cyc = 50;
    n.setMcuOutput('PM6', 1);
    expect(seen).toEqual([['PM6', 0, 42], ['PM6', 1, 50]]);
    n.driveByte('PB', 0xa5);
    expect(n.readByte('PB')).toBe(0xa5);
    for (let i = 0; i < 8; i++) n.setMcuOutput(`PK${i}`, (i & 1) as 0 | 1);
    expect(n.mcuByte('PK')).toBe(0xaa);
  });
  it('externalChange syncs and reschedules around the drive', () => {
    const n = new PinNet();
    const log: string[] = [];
    n.syncHook = () => log.push('sync');
    n.rescheduleHook = () => log.push('resched');
    n.on('PJ7', () => log.push('pin'));
    n.externalChange([['PJ7', 0]]);
    expect(log).toEqual(['sync', 'pin', 'resched']);
  });
});

describe('SpiBus', () => {
  it('only selected slaves exchange; open bus reads $FF', () => {
    const bus = new SpiBus('SPI0');
    let sel = false;
    const got: number[] = [];
    bus.attach({ name: 's', selected: () => sel, exchange: (m) => (got.push(m), 0x3c) });
    const mode = { cpol: 0 as const, cpha: 0 as const, lsbFirst: false };
    expect(bus.exchange(0x11, 0, mode)).toBe(0xff);
    sel = true;
    expect(bus.exchange(0x22, 0, mode)).toBe(0x3c);
    expect(got).toEqual([0x22]);
    expect(createBoardNets().spi.SPI0.name).toBe('SPI0');
  });
});
