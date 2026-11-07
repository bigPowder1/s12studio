import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { S12Provider } from '../../common/s12';
import { createMockS12 } from '../../common/testing/mockS12';
import type { BuildMessageInfo, BuildResultInfo } from '../../../shared/api';
import { registerIdeCommand, runIdeCommand } from '../commands';
import { ErrorsList, ErrorsWindow, messageLines, nextBuildMessage, previousBuildMessage, stepMessage } from './ErrorsWindow';

const MAIN = '/tmp/Lab3/Sources/main.asm';
const MSGS: BuildMessageInfo[] = [
  { severity: 'error', tool: 'assembler', code: 'A1104', text: 'Undeclared user defined symbol: FOO', file: MAIN, line: 3, column: 9, display: 'Error   : A1104: Undeclared user defined symbol: FOO\nmain.asm line 3\n' },
  { severity: 'warning', tool: 'assembler', code: 'A1001', text: 'Conditional else not allowed here', file: MAIN, line: 5, display: 'Warning : A1001: Conditional else not allowed here\nmain.asm line 5\n' },
  { severity: 'information', tool: 'project', text: 'Link done', display: 'Information: Link done\n' },
  { severity: 'error', tool: 'linker', code: 'L1822', text: 'Symbol BAR in file main.asm.o is undefined', file: MAIN, display: 'Error   : L1822: Symbol BAR in file main.asm.o is undefined\nmain.asm\n' },
];

const result = (messages: BuildMessageInfo[]): BuildResultInfo => ({ ok: false, target: 'Standard', errors: 2, warnings: 1, messages, upToDate: false, compiled: [], skipped: [], linked: false, burned: false, outputs: [], files: [], elapsedMs: 5 });

describe('Errors & Warnings helpers', () => {
  it('splits the CodeWarrior display text into message and location lines', () => {
    expect(messageLines(MSGS[0])).toEqual(['Error   : A1104: Undeclared user defined symbol: FOO', 'main.asm line 3']);
    expect(messageLines(MSGS[2])).toEqual(['Information: Link done', '']);
    expect(messageLines({ severity: 'warning', tool: 'assembler', code: 'A2', text: 't', file: 'C:\\x\\a.asm', line: 7, display: '' })).toEqual(['Warning : A2: t', 'a.asm line 7']);
  });

  it('steps to the next / previous message that has a file, wrapping', () => {
    expect(stepMessage(MSGS, -1, 1)).toBe(0);
    expect(stepMessage(MSGS, 0, 1)).toBe(1);
    expect(stepMessage(MSGS, 1, 1)).toBe(3); // skips the message without a file
    expect(stepMessage(MSGS, 3, 1)).toBe(0);
    expect(stepMessage(MSGS, -1, -1)).toBe(3);
    expect(stepMessage(MSGS, 0, -1)).toBe(3);
    expect(stepMessage([], -1, 1)).toBe(-1);
  });
});

describe('<ErrorsList>', () => {
  it('renders icon, code, text, file and line per message with counts', () => {
    render(<ErrorsList messages={MSGS} onJump={vi.fn()} />);
    const rows = screen.getAllByTestId('errors-row');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute('data-severity'))).toEqual(['error', 'warning', 'information', 'error']);
    expect(within(rows[0]).getByRole('img', { name: 'Error' })).toBeInTheDocument();
    expect(within(rows[1]).getByRole('img', { name: 'Warning' })).toBeInTheDocument();
    expect(within(rows[2]).getByRole('img', { name: 'Message' })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('Error : A1104: Undeclared user defined symbol: FOO');
    expect(rows[0]).toHaveTextContent('main.asm line 3');
    expect(screen.getByTestId('errors-filter-error')).toHaveTextContent('2');
    expect(screen.getByTestId('errors-filter-warning')).toHaveTextContent('1');
    expect(screen.getByTestId('errors-filter-information')).toHaveTextContent('1');
    expect(screen.getByTestId('errors-summary')).toHaveTextContent('2 errors, 1 warning, 1 message');
  });

  it('double-click and Enter jump to the message; arrows move the selection', async () => {
    const onJump = vi.fn();
    render(<ErrorsList messages={MSGS} onJump={onJump} />);
    const rows = screen.getAllByTestId('errors-row');
    await userEvent.dblClick(rows[1]);
    expect(onJump).toHaveBeenLastCalledWith(MSGS[1]);
    const list = screen.getByTestId('errors-list');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onJump).toHaveBeenLastCalledWith(MSGS[0]);
    expect(screen.getAllByTestId('errors-row')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('filter toggles hide severities', async () => {
    const onFilter = vi.fn();
    const { rerender } = render(<ErrorsList messages={MSGS} onJump={vi.fn()} onFilterChange={onFilter} />);
    await userEvent.click(screen.getByTestId('errors-filter-warning'));
    expect(onFilter).toHaveBeenCalledWith({ error: true, warning: false, information: true });
    rerender(<ErrorsList messages={MSGS} onJump={vi.fn()} filter={{ error: true, warning: false, information: false }} />);
    expect(screen.getAllByTestId('errors-row').map((r) => r.getAttribute('data-severity'))).toEqual(['error', 'error']);
    expect(screen.getByTestId('errors-filter-warning')).toHaveAttribute('aria-pressed', 'false');
    rerender(<ErrorsList messages={MSGS} onJump={vi.fn()} filter={{ error: false, warning: false, information: false }} />);
    expect(screen.getByText('All messages are filtered out')).toBeInTheDocument();
  });

  it('next / previous buttons select and jump; the source pane shows the line in context', async () => {
    const onJump = vi.fn();
    const readSource = vi.fn(async () => ['l1', 'l2', 'ldaa FOO', 'l4', 'l5', 'l6'].join('\n'));
    render(<ErrorsList messages={MSGS} onJump={onJump} readSource={readSource} />);
    await userEvent.click(screen.getByTestId('errors-next'));
    expect(onJump).toHaveBeenLastCalledWith(MSGS[0]);
    await waitFor(() => expect(screen.getByTestId('errors-source')).toHaveTextContent('ldaa FOO'));
    expect(screen.getByText('ldaa FOO')).toHaveClass('current');
    expect(readSource).toHaveBeenCalledWith(MAIN);
    await userEvent.click(screen.getByTestId('errors-next'));
    expect(onJump).toHaveBeenLastCalledWith(MSGS[1]);
    await userEvent.click(screen.getByTestId('errors-prev'));
    expect(onJump).toHaveBeenLastCalledWith(MSGS[0]);
  });
});

describe('<ErrorsWindow>', () => {
  it('opens on errors.show, follows build events and jumps with editor.open', async () => {
    const mock = createMockS12({ files: { readText: async (p: string) => ({ path: p, text: 'a\nb\nc', eol: 'crlf' as const, mtimeMs: 1, readOnly: false }) } });
    const opened: unknown[] = [];
    const off = registerIdeCommand('editor.open', (a) => void opened.push(a));
    render(
      <S12Provider api={mock.api}>
        <ErrorsWindow />
      </S12Provider>,
    );
    expect(screen.queryByTestId('errors-window')).toBeNull();
    act(() => runIdeCommand('errors.show'));
    expect(screen.getByTestId('errors-window')).toHaveTextContent('Errors & Warnings');
    expect(screen.getByText('No errors or warnings')).toBeInTheDocument();
    act(() => {
      mock.emit('build', 'started', { kind: 'make', target: 'Standard' });
      mock.emit('build', 'message', MSGS[0]);
    });
    expect(screen.getAllByTestId('errors-row')).toHaveLength(1);
    act(() => mock.emit('build', 'finished', result(MSGS)));
    expect(screen.getAllByTestId('errors-row')).toHaveLength(4);
    await userEvent.dblClick(screen.getAllByTestId('errors-row')[0]);
    expect(opened).toEqual([{ path: MAIN, line: 3, column: 9 }]);
    // F4 = next message with a location
    fireEvent.keyDown(window, { key: 'F4' });
    expect(opened.at(-1)).toEqual({ path: MAIN, line: 5, column: undefined });
    fireEvent.keyDown(window, { key: 'F4', shiftKey: true });
    expect(opened.at(-1)).toEqual({ path: MAIN, line: 3, column: 9 });
    // double-clicking a message without a file does nothing
    const n = opened.length;
    await userEvent.dblClick(screen.getAllByTestId('errors-row')[2]);
    expect(opened).toHaveLength(n);
    await userEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByTestId('errors-window')).toBeNull();
    off();
  });

  it('restores the last build result on mount', async () => {
    const mock = createMockS12({ build: { lastResult: async () => result(MSGS.slice(0, 2)) } });
    render(
      <S12Provider api={mock.api}>
        <ErrorsWindow initiallyOpen onJump={vi.fn()} />
      </S12Provider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('errors-row')).toHaveLength(2));
  });

  it('F4 with the window closed opens it and jumps in one go (review: needed a second F4)', async () => {
    const mock = createMockS12();
    const onJump = vi.fn();
    render(
      <S12Provider api={mock.api}>
        <ErrorsWindow onJump={onJump} />
      </S12Provider>,
    );
    act(() => mock.emit('build', 'finished', result(MSGS)));
    expect(screen.queryByTestId('errors-window')).toBeNull();
    fireEvent.keyDown(window, { key: 'F4' });
    expect(screen.getByTestId('errors-window')).toBeVisible();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenLastCalledWith(MSGS[0]);
    // close again: the next F4 continues from the selected message
    await userEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByTestId('errors-window')).toBeNull();
    act(() => nextBuildMessage());
    expect(onJump).toHaveBeenLastCalledWith(MSGS[1]);
    act(() => previousBuildMessage());
    expect(onJump).toHaveBeenLastCalledWith(MSGS[0]);
    expect(onJump).toHaveBeenCalledTimes(3);
  });
});

describe('<ErrorsList> after a rebuild', () => {
  it('selects the first new message and re-reads the source for the new messages', async () => {
    let disk = ['l1', 'l2', 'ldaa FIRST_BAD', 'l4'].join('\n');
    const readSource = vi.fn(async () => disk);
    const first: BuildMessageInfo[] = [{ ...MSGS[0], text: 'FIRST_BAD', display: '' }];
    const { rerender } = render(<ErrorsList messages={first} onJump={vi.fn()} readSource={readSource} />);
    await userEvent.click(screen.getByTestId('errors-row'));
    await waitFor(() => expect(screen.getByTestId('errors-source')).toHaveTextContent('ldaa FIRST_BAD'));
    // rebuild: the file changed, the new message is on another line
    disk = ['l1', 'l2', 'l3', 'l4', 'ldaa SECOND_BAD'].join('\n');
    const second: BuildMessageInfo[] = [{ ...MSGS[0], text: 'SECOND_BAD', line: 5, display: '' }];
    rerender(<ErrorsList messages={second} onJump={vi.fn()} readSource={readSource} />);
    // final fidelity F14: the first message of the new list is selected, its source shows without a click
    expect(screen.getByTestId('errors-row')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('errors-source')).not.toHaveTextContent('FIRST_BAD');
    await waitFor(() => expect(screen.getByTestId('errors-source')).toHaveTextContent('ldaa SECOND_BAD'));
    expect(screen.getByTestId('errors-source')).not.toHaveTextContent('FIRST_BAD');
    expect(readSource).toHaveBeenCalledTimes(2);
  });
});
