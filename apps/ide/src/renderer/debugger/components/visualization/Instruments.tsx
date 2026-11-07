/** Instrument faces of VisualizationTool-lite (pure views: value in, drawing out). */
import type { Instrument } from './model';
import { barFraction, formatText, ledOn, seg7Digits } from './model';

const LED_COLORS: Record<string, [string, string]> = {
  red: ['#ff3030', '#4a1010'],
  green: ['#30e030', '#103a10'],
  yellow: ['#ffe030', '#4a4010'],
  blue: ['#40a0ff', '#10284a'],
};

export function LedFace({ inst, value }: { inst: Instrument; value: number | null }) {
  const on = ledOn(inst, value);
  const [lit, dark] = LED_COLORS[inst.color ?? 'red'];
  return (
    <svg width={28} height={28} viewBox="0 0 28 28" data-state={on === null ? 'unknown' : on ? 'on' : 'off'}>
      <circle cx={14} cy={14} r={11} fill={on ? lit : dark} stroke="#000" strokeWidth={1} opacity={on === null ? 0.4 : 1} />
      {on && <circle cx={10} cy={10} r={3} fill="#fff" opacity={0.6} />}
    </svg>
  );
}

// segment polygons of one digit in a 20x34 box (a top, b upper right, c lower right, d bottom, e lower left,
// f upper left, g middle)
const SEGS = ['3,1 17,1 14,4 6,4', '18,2 18,16 15,15 15,5', '18,18 18,32 15,29 15,19', '3,33 17,33 14,30 6,30', '2,18 5,19 5,29 2,32', '2,2 5,5 5,15 2,16', '3,17 6,15 14,15 17,17 14,19 6,19'];

export function Seg7Face({ inst, value }: { inst: Instrument; value: number | null }) {
  const digits = seg7Digits(inst, value);
  return (
    <svg width={digits.length * 24 + 4} height={40} viewBox={`0 0 ${digits.length * 24 + 4} 40`} data-digits={digits.map((d) => d.toString(16).padStart(2, '0')).join(' ')}>
      <rect width="100%" height="100%" fill="#111" rx={3} />
      {digits.map((mask, i) => (
        <g key={i} transform={`translate(${4 + i * 24} 3)`}>
          {SEGS.map((p, s) => (
            <polygon key={s} points={p} fill={(mask >> s) & 1 ? '#ff2a1a' : '#3a0d0a'} />
          ))}
          <circle cx={20.5} cy={32} r={1.6} fill={mask & 0x80 ? '#ff2a1a' : '#3a0d0a'} />
        </g>
      ))}
    </svg>
  );
}

export function BarFace({ inst, value }: { inst: Instrument; value: number | null }) {
  const f = barFraction(inst, value);
  return (
    <div className="vis-bar" data-fraction={f.toFixed(3)}>
      <div className="vis-bar-track">
        <div className="vis-bar-fill" style={{ width: `${(f * 100).toFixed(1)}%` }} />
      </div>
      <div className="vis-bar-scale">
        <span>{inst.min ?? 0}</span>
        <span>{value ?? '--'}</span>
        <span>{inst.max ?? (inst.size === 2 ? 0xffff : 0xff)}</span>
      </div>
    </div>
  );
}

export function TextFace({ inst, value }: { inst: Instrument; value: number | null }) {
  return <span className="vis-text cw-mono">{formatText(inst, value)}</span>;
}

export function InstrumentFace({ inst, value }: { inst: Instrument; value: number | null }) {
  switch (inst.kind) {
    case 'led':
      return <LedFace inst={inst} value={value} />;
    case 'seg7':
      return <Seg7Face inst={inst} value={value} />;
    case 'bar':
      return <BarFace inst={inst} value={value} />;
    case 'text':
      return <TextFace inst={inst} value={value} />;
  }
}
