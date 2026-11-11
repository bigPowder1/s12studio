/**
 * ME3305 motor, encoder and DAC readouts: a rotating shaft/disc drawn at the model's shaft angle, speed (rpm),
 * winding current (mA), drive voltage/duty, direction (PA4) and enable (PA6); the LS7366R count; MCP4922 outputs
 * A/B as voltmeter bars (0..Vref, Vref = 5 V UNCERTAIN, see ME3305.dac).
 * At high speed the disc is sampled at the snapshot rate and would alias, so above BLUR_RPM a motion-blur ring is
 * drawn instead of trusting the marker position.
 */
import { ME3305 } from '@s12/devices';
import type { MotorStateInfo } from '../../../../shared/api';

export const BLUR_RPM = 120;
const VREF = ME3305.dac.vrefVolts;

const fmt = (v: number, d: number) => {
  if (!Number.isFinite(v)) return '-';
  const t = v.toFixed(d);
  return /^-0\.?0*$/.test(t) ? t.slice(1) : t; // no "-0.0"
};

export function MotorView({ motor }: { motor: MotorStateInfo | null }) {
  const deg = motor ? ((motor.angle * 180) / Math.PI) % 360 : 0;
  const fast = !!motor && Math.abs(motor.rpm) > BLUR_RPM;
  const spokes = [0, 60, 120, 180, 240, 300];
  return (
    <div className="me3305-motor" data-testid="me3305-motor">
      <svg viewBox="-50 -50 100 100" className="me3305-motor-svg" role="img" aria-label={`Motor ${motor ? fmt(motor.rpm, 0) : 0} rpm`}>
        <circle r={47} className="me3305-motor-housing" />
        <g transform={`rotate(${deg.toFixed(2)})`} data-testid="me3305-motor-disc" data-angle={deg.toFixed(1)}>
          <circle r={38} className="me3305-motor-disc" />
          {spokes.map((a) => (
            <line key={a} x1={0} y1={0} x2={34 * Math.cos((a * Math.PI) / 180)} y2={34 * Math.sin((a * Math.PI) / 180)} className="me3305-motor-spoke" />
          ))}
          <circle cx={0} cy={-30} r={5} className="me3305-motor-marker" />
        </g>
        {fast && <circle r={30} className="me3305-motor-blur" />}
        <circle r={7} className="me3305-motor-shaft" />
      </svg>
      <table className="me3305-readout">
        <tbody>
          <tr>
            <th>Speed</th>
            <td data-testid="motor-rpm">{motor ? `${fmt(motor.rpm, 1)} rpm` : '-'}</td>
          </tr>
          <tr>
            <th>Current</th>
            <td data-testid="motor-current">{motor ? `${fmt(motor.current * 1000, 1)} mA` : '-'}</td>
          </tr>
          <tr>
            <th>Drive</th>
            <td>{motor ? `${fmt(motor.volts, 2)} V (${fmt(motor.duty * 100, 1)} %)` : '-'}</td>
          </tr>
          <tr>
            <th>Dir / En</th>
            <td>
              <span className={`me3305-flag${motor && motor.direction > 0 ? ' on' : ''}`} title="PA4 direction">
                {motor ? (motor.direction > 0 ? 'FWD' : 'REV') : 'DIR'}
              </span>{' '}
              <span className={`me3305-flag${motor?.enabled ? ' on' : ''}`} title="PA6 enable" data-testid="motor-enabled">
                {motor?.enabled ? 'ENABLED' : 'DISABLED'}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function DacMeter({ name, volts }: { name: string; volts: number }) {
  const frac = Math.max(0, Math.min(1, volts / VREF));
  return (
    <div className="me3305-dac" data-testid={`dac-${name}`}>
      <span className="me3305-dac-name">DAC {name}</span>
      <div className="me3305-dac-bar" role="meter" aria-valuemin={0} aria-valuemax={VREF} aria-valuenow={volts} aria-label={`DAC ${name}`}>
        <div className="me3305-dac-fill" style={{ width: `${(frac * 100).toFixed(1)}%` }} />
        {[0.25, 0.5, 0.75].map((t) => (
          <div key={t} className="me3305-dac-tick" style={{ left: `${t * 100}%` }} />
        ))}
      </div>
      <span className="me3305-dac-value">{fmt(volts, 3)} V</span>
    </div>
  );
}

export function EncoderView({ count }: { count: number }) {
  const u = count & 0xffff;
  const s = u >= 0x8000 ? u - 0x10000 : u;
  return (
    <div className="me3305-encoder" data-testid="me3305-encoder" title="LS7366R CNTR (16-bit)">
      <span>Encoder</span>
      <span className="me3305-encoder-value" data-testid="encoder-count">
        {s}
      </span>
      <span className="me3305-encoder-hex">${u.toString(16).toUpperCase().padStart(4, '0')}</span>
    </div>
  );
}
