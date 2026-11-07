/**
 * The project's file name as the IDE shows it (window title, project window caption, menus): `<name>.mcp` for a
 * CodeWarrior project, `<name>.s12studio.json` for a standalone S12 Studio project (examples/, New Project), which
 * has no .mcp.
 */
import type { ProjectInfo } from '../../../shared/api';

export function projectFileName(p: Pick<ProjectInfo, 'name' | 'mcpPath' | 'path'>): string {
  return !p.mcpPath && /\.s12studio\.json$/i.test(p.path ?? '') ? `${p.name}.s12studio.json` : `${p.name}.mcp`;
}
