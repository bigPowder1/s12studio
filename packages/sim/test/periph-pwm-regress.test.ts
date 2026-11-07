// Regression tests for review findings on pwm.ts (PWM7IN reflects the PP7 pin).
import { describe, expect, it } from 'vitest';
import { S12XSystem, createBoardNets } from '@s12/sim';
import { addr } from '@s12/devices';
import { PWM_RANGE, PwmModule } from '../src/periph/pwm';

function rig() {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  const pwm = new PwmModule(nets);
  s.addPeripheral(pwm, [PWM_RANGE]);
  s.reset();
  return { s, nets, pwm };
}

describe('PWMSDN.PWM7IN', () => {
  it('reads 0 at reset with PP7 floating (documented reset value)', () => {
    const { s } = rig();
    expect(s.peek(addr('PWMSDN'))).toBe(0);
  });

  it('follows the PP7 pin level with PWM7ENA = 0', () => {
    const { s, nets } = rig();
    nets.pins.drive('PP7', 1);
    expect(s.peek(addr('PWMSDN')) & 0x04).toBe(0x04);
    nets.pins.drive('PP7', 0);
    expect(s.peek(addr('PWMSDN')) & 0x04).toBe(0);
    expect(s.peek(addr('PWMSDN')) & 0x01).toBe(0); // PWM7ENA still 0, no shutdown
  });

  it('follows the PP7 pin level with PWM7ENA = 1', () => {
    const { s, nets } = rig();
    nets.pins.drive('PP7', 0);
    s.bus.regWrite(addr('PWMSDN'), 0x01, 0); // PWM7ENA, PWM7INL = 0 (active low)
    expect(s.peek(addr('PWMSDN')) & 0x04).toBe(0);
    nets.pins.drive('PP7', 1);
    expect(s.peek(addr('PWMSDN')) & 0x04).toBe(0x04);
  });
});
