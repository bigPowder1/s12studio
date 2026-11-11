/**
 * Debugger component registry: hiwave component name -> React component. The shell opens components from a .hwl
 * (`OPEN source ...`), from Component > Open, and from `OPEN` commands, through `findComponent()`.
 * Each component folder exports its component from index.ts; to add a component, add it here.
 */
import type { ComponentType } from 'react';
import { AssemblyComponent } from './assembly';
import { BoardComponent } from './board';
import { CommandComponent } from './command';
import type { DebuggerComponentProps, HiwaveComponentName } from './contract';
import { DataComponent } from './data';
import { MemoryComponent } from './memory';
import { ProcedureComponent } from './procedure';
import { RegisterComponent } from './register';
import { SourceComponent } from './source';
import { TerminalComponent } from './terminal';
import { VisualizationComponent } from './visualization';

export interface ComponentEntry {
  name: HiwaveComponentName;
  component: ComponentType<DebuggerComponentProps>;
  /** Several instances allowed (Memory:1, Memory:2, Data:1...). */
  multiInstance: boolean;
  /** Component > Open description. */
  description: string;
  /** Extra names accepted by OPEN (lower case). */
  aliases?: string[];
  /**
   * hiwave shows this component's Object Info Bar permanently (empty when there is nothing to say), so the body keeps
   * its height when the text comes and goes. Others show the bar only while the component has text for it.
   */
  infoBar?: boolean;
}

export const COMPONENTS: readonly ComponentEntry[] = [
  { name: 'Source', component: SourceComponent, multiInstance: false, infoBar: true, description: 'Source code window' },
  { name: 'Assembly', component: AssemblyComponent, multiInstance: false, infoBar: true, description: 'Disassembly window' },
  { name: 'Register', component: RegisterComponent, multiInstance: false, infoBar: true, description: 'CPU registers' },
  { name: 'Procedure', component: ProcedureComponent, multiInstance: false, infoBar: true, description: 'Procedure chain' },
  { name: 'Memory', component: MemoryComponent, multiInstance: true, infoBar: true, description: 'Memory dump' },
  { name: 'Data', component: DataComponent, multiInstance: true, infoBar: true, description: 'Global, local and user variables' },
  { name: 'Command', component: CommandComponent, multiInstance: false, description: 'Command line' },
  { name: 'Terminal', component: TerminalComponent, multiInstance: false, description: 'Terminal (SCI)' },
  // the course was renumbered ME 305 -> ME 3305: layouts saved with the old name ("ME305 Board") still open the board
  { name: 'ME3305 Board', component: BoardComponent, multiInstance: false, description: 'ME3305 board: LCD, keypad, LEDs, motor', aliases: ['me3305', 'board', 'me3305board', 'me305 board', 'me305', 'me305board'] },
  { name: 'VisualizationTool', component: VisualizationComponent, multiInstance: true, description: 'Visualization instruments', aliases: ['visualization'] },
];

/** Case-insensitive lookup by name or alias ("source", "ME3305 Board", "me3305"). */
export function findComponent(name: string): ComponentEntry | undefined {
  const n = name.trim().toLowerCase();
  const compact = n.replace(/[\s_]/g, '');
  return COMPONENTS.find((c) => c.name.toLowerCase() === n || c.name.toLowerCase().replace(/\s/g, '') === compact || c.aliases?.includes(n) || c.aliases?.includes(compact));
}
