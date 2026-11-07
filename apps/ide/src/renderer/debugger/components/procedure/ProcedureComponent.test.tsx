import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockS12 } from '../../../common/testing/mockS12';
import { S12Provider } from '../../../common/s12';
import { DebuggerBusContext, type DebuggerBus } from '../../shell/bus';
import { snapshot } from '../../shell/testing';
import type { UiCommandInfo } from '../../../../shared/api';
import { frameText, ProcedureComponent } from './ProcedureComponent';

describe('ProcedureComponent', () => {
  it('lists the call chain after a halt; double-click shows the location in Source and Assembly', async () => {
    const frames = [
      { level: 0, name: 'DELAY_MILLI', pc: 0xc040, source: { file: 'C:\\Lab3\\bin\\main.dbg', line: 120 } },
      { level: 1, name: 'main', pc: 0xc006 },
    ];
    const m = createMockS12({ debug: { callStack: async () => frames } });
    const sent: UiCommandInfo[] = [];
    const bus: DebuggerBus = { send: (c) => sent.push(c), setAttributes: () => undefined, status: () => undefined };
    render(
      <S12Provider api={m.api}>
        <DebuggerBusContext.Provider value={bus}>
          <ProcedureComponent instanceId="w3" title="Procedure" instance={1} attributes={[{ name: 'VALUES', value: 'on' }]} active />
        </DebuggerBusContext.Provider>
      </S12Provider>,
    );
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc040 } })));
    await waitFor(() => expect(screen.getByTestId('proc-frame-0')).toHaveTextContent('DELAY_MILLI ( ) main.dbg:120'));
    expect(screen.getByTestId('proc-frame-1')).toHaveTextContent('main ( ) 0xC006');
    fireEvent.doubleClick(screen.getByTestId('proc-frame-1'));
    expect(sent.map((c) => [c.component, c.keyword, c.argText])).toEqual([
      ['Source', 'SPC', '0xC006'],
      ['Assembly', 'SPC', '0xC006'],
    ]);
  });

  it('formats frames', () => {
    expect(frameText({ level: 0, name: 'main', pc: 0xc000 }, false)).toBe('main ( )');
    expect(frameText({ level: 0, name: '0xC000', pc: 0xc000 }, true)).toBe('0xC000    0xC000');
  });
});
