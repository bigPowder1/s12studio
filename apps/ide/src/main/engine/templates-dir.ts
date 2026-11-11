/**
 * Where File > New Project finds an ME 3305 `blank_project` template. S12 Studio ships no course content: the template
 * is the user's own copy of the course's blank_project folder (a CodeWarrior project with its .mcp). Lookup (first
 * match; candidate list: templateCandidates below): $S12_TEMPLATES_DIR, <userData>/templates (copy the course's
 * blank_project there), or - in a source checkout only - the private fixtures ($S12_FIXTURES or <repo>/fixtures;
 * copied, never written).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * First candidate directory holding a usable `blank_project/`: a CodeWarrior project folder (`blank_project/<x>.mcp`).
 * Undefined when none.
 */
export function findTemplatesDir(candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (!c) continue;
    const dir = resolve(c);
    const bp = join(dir, 'blank_project');
    try {
      if (!existsSync(bp)) continue;
      if (readdirSync(bp).some((n) => n.toLowerCase().endsWith('.mcp'))) return dir;
    } catch {
      // unreadable: next candidate
    }
  }
  return undefined;
}

export interface TemplateLocations {
  /** process.env (S12_TEMPLATES_DIR, S12_FIXTURES). */
  env: Record<string, string | undefined>;
  userData: string;
  /** apps/ide in a checkout, <resources>/app.asar when packaged. */
  appDir: string;
  packaged: boolean;
  /** process.resourcesPath (packaged builds; unused: installers bundle no templates). */
  resourcesPath: string;
}

/** The per-user templates folder (<userData>/templates) that File > New Project lists a blank_project copy from. */
export function userTemplatesDir(userData: string): string {
  return join(userData, 'templates');
}

/** Candidate template directories in lookup order (for findTemplatesDir). */
export function templateCandidates(l: TemplateLocations): (string | undefined)[] {
  const fixtures = l.env.S12_FIXTURES ? resolve(l.env.S12_FIXTURES) : join(l.appDir, '../../fixtures');
  return [
    l.env.S12_TEMPLATES_DIR || undefined,
    userTemplatesDir(l.userData),
    l.packaged ? undefined : fixtures, // source checkout with the private fixtures (read-only: copied, never written)
  ];
}
