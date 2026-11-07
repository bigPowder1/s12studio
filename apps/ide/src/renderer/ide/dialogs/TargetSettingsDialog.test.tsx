import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockS12 } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import { lab3Info } from '../testing/lab3-model';
import { TargetSettingsDialog } from './TargetSettingsDialog';
import { NewProjectDialog } from './NewProjectDialog';

function setup(onClose: () => void = () => undefined) {
  const info = lab3Info();
  const m = createMockS12({
    project: {
      current: async () => info,
      setOption: async () => info,
      setAccessPaths: async () => info,
      setOutput: async () => info,
      setDebuggerArgs: async () => info,
    },
    files: { openDialog: async () => ['/p/Sources/Libraries'] },
  });
  render(
    <S12Provider api={m.api}>
      <TargetSettingsDialog open onClose={onClose} />
    </S12Provider>,
  );
  return m;
}

const panel = (label: string) => fireEvent.mouseDown(within(screen.getByTestId('ts-panels')).getByText(label));

describe('Target Settings dialog', () => {
  it('lists the CW panel tree and shows the Target Settings panel', async () => {
    setup();
    expect(await screen.findByRole('dialog', { name: 'Standard Settings' })).toBeInTheDocument();
    const tree = screen.getByTestId('ts-panels');
    for (const l of ['Target', 'Target Settings', 'Access Paths', 'Build Extras', 'Runtime Settings', 'File Mappings', 'Source Trees', 'Assembler for HC12', 'Burner for HC12', 'Importer for HC12', 'Linker for HC12', 'Code Generation', 'Editor']) {
      expect(within(tree).getByText(l)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Target Name')).toHaveValue('Standard');
    expect(screen.getByTestId('ts-output-dir')).toHaveValue('{Project}bin');
    expect(screen.getByTestId('ts-apply')).toBeDisabled();
  });

  it('editing the assembler options and Apply calls project.setOption', async () => {
    const m = setup();
    await screen.findByTestId('ts-panels');
    panel('Assembler for HC12');
    const f = screen.getByTestId('ts-opt-assembler');
    expect(f).toHaveValue('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li');
    fireEvent.change(f, { target: { value: '-CPUHCS12X -Li' } });
    expect(screen.getByTestId('ts-apply')).toBeEnabled();
    fireEvent.click(screen.getByTestId('ts-apply'));
    await waitFor(() => expect(m.calls('project', 'setOption')).toEqual([['Standard', 'assembler', '-CPUHCS12X -Li']]));
    expect(m.calls('project', 'setAccessPaths')).toEqual([]);
  });

  it('the Options... dialog toggles flags into the option string; OK saves and closes', async () => {
    let closed = false;
    const m = setup(() => (closed = true));
    await screen.findByTestId('ts-panels');
    panel('Assembler for HC12');
    fireEvent.click(screen.getByTestId('ts-asm-options'));
    const dlg = screen.getByTestId('asm-options-dialog');
    expect(within(dlg).getByTestId('asmopt--L')).toBeChecked();
    expect(within(dlg).getByTestId('asmopt--Li')).toBeChecked();
    fireEvent.click(within(dlg).getByTestId('asmopt--Li')); // off
    fireEvent.mouseDown(within(dlg).getByRole('tab', { name: 'Language' }));
    fireEvent.click(within(dlg).getByTestId('asmopt--Ci'));
    fireEvent.mouseDown(within(dlg).getByRole('tab', { name: 'Code Generation' }));
    expect(within(dlg).getByTestId('asmopt-cpu--CPUHCS12X')).toBeChecked();
    expect(within(dlg).getByTestId('asm-options-cmdline')).toHaveValue('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Ci');
    fireEvent.click(screen.getByTestId('asm-options-ok'));
    expect(screen.queryByTestId('asm-options-dialog')).toBeNull();
    expect(screen.getByTestId('ts-opt-assembler')).toHaveValue('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Ci');
    fireEvent.click(screen.getByTestId('ts-ok'));
    await waitFor(() => expect(closed).toBe(true));
    expect(m.calls('project', 'setOption')).toEqual([['Standard', 'assembler', '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Ci']]);
  });

  it('access paths: add (as {Project} path) and remove produce one setAccessPaths call', async () => {
    const m = setup();
    await screen.findByTestId('ts-panels');
    panel('Access Paths');
    const list = screen.getByTestId('ts-path-list');
    expect(within(list).getByText('{Project}..\\..\\SharedLibs')).toBeInTheDocument();
    expect(within(list).getByText('not found')).toBeInTheDocument();
    fireEvent.mouseDown(within(list).getByText('{Project}prm'));
    fireEvent.click(screen.getByTestId('ts-path-remove'));
    fireEvent.click(screen.getByTestId('ts-path-add'));
    await waitFor(() => expect(within(list).getByText('{Project}Sources\\Libraries')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ts-apply'));
    await waitFor(() =>
      expect(m.calls('project', 'setAccessPaths')).toEqual([
        ['Standard', { user: ['{Project}', '{Project}bin', '{Project}Sources', '{Project}..\\..\\SharedLibs', '{Project}Sources\\Libraries'], system: ['{Compiler}lib\\HC12c\\include'] }],
      ]),
    );
  });

  it('Linker panel edits the application filename (setOutput); Revert Panel undoes; Cancel saves nothing', async () => {
    let closed = false;
    const m = setup(() => (closed = true));
    await screen.findByTestId('ts-panels');
    panel('Linker for HC12');
    expect(screen.getByTestId('ts-panel-linker')).toHaveTextContent('Project.prm');
    fireEvent.change(screen.getByTestId('ts-output-file'), { target: { value: 'Lab3.abs' } });
    fireEvent.click(screen.getByTestId('ts-revert'));
    expect(screen.getByTestId('ts-output-file')).toHaveValue('Project.abs');
    fireEvent.change(screen.getByTestId('ts-output-file'), { target: { value: 'Lab3.abs' } });
    fireEvent.click(screen.getByTestId('ts-apply'));
    await waitFor(() => expect(m.calls('project', 'setOutput')).toEqual([['Standard', { file: 'Lab3.abs' }]]));
    panel('Build Extras');
    fireEvent.change(screen.getByTestId('ts-debugger-args'), { target: { value: '%targetFilePath -Prod=%projectFileDir\\Full_Chip_Simulation.ini -instance=sim' } });
    fireEvent.click(screen.getByTestId('ts-cancel'));
    expect(closed).toBe(true);
    expect(m.calls('project', 'setDebuggerArgs')).toEqual([]);
  });

  it('rejects an invalid application filename', async () => {
    const m = setup();
    await screen.findByTestId('ts-panels');
    panel('Linker for HC12');
    fireEvent.change(screen.getByTestId('ts-output-file'), { target: { value: 'bin/x.abs' } });
    fireEvent.click(screen.getByTestId('ts-apply'));
    expect(await screen.findByRole('alert')).toHaveTextContent('plain file name');
    expect(m.calls('project', 'setOutput')).toEqual([]);
  });
});

describe('New Project dialog', () => {
  it('creates the chosen stationery at <location>/<name>', async () => {
    const m = createMockS12({ files: { openDialog: async () => ['/home/u/labs'] } });
    let closed = false;
    render(
      <S12Provider api={m.api}>
        <NewProjectDialog open onClose={() => (closed = true)} />
      </S12Provider>,
    );
    // wizard: Device and Connection first, then Project Parameters (final fidelity F2)
    expect(screen.getByTestId('np-page-device')).toHaveTextContent('MC9S12XDP512');
    expect(screen.getByTestId('np-back')).toBeDisabled();
    fireEvent.click(screen.getByTestId('np-next'));
    fireEvent.click(screen.getByText('Set...'));
    await waitFor(() => expect(screen.getByTestId('np-dir')).toHaveValue('/home/u/labs'));
    fireEvent.change(screen.getByTestId('np-name'), { target: { value: 'Lab4.mcp' } });
    fireEvent.mouseDown(within(screen.getByTestId('np-templates')).getByText(/generic/));
    fireEvent.click(screen.getByTestId('np-finish'));
    await waitFor(() => expect(closed).toBe(true));
    expect(m.calls('project', 'newProject')).toEqual([[{ template: 'minimal', dir: '/home/u/labs', name: 'Lab4' }]]);
  });

  it('validates the name', async () => {
    const m = createMockS12();
    render(
      <S12Provider api={m.api}>
        <NewProjectDialog open onClose={() => undefined} />
      </S12Provider>,
    );
    fireEvent.click(screen.getByTestId('np-next'));
    fireEvent.change(screen.getByTestId('np-name'), { target: { value: 'a:b' } });
    fireEvent.change(screen.getByTestId('np-dir'), { target: { value: '/x' } });
    fireEvent.click(screen.getByTestId('np-next'));
    expect(screen.getByTestId('np-page-files')).toBeInTheDocument();
    expect(screen.getByTestId('np-next')).toBeDisabled();
    fireEvent.click(screen.getByTestId('np-finish'));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid project name');
    // Finish with a bad name goes back to Project Parameters, where the field is
    expect(screen.getByTestId('np-page-params')).toBeInTheDocument();
    expect(m.calls('project', 'newProject')).toEqual([]);
  });
});
