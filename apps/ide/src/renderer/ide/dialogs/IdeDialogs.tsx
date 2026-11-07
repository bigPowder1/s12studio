/**
 * IDE dialogs host: every dialog registers the IDE command that opens it (commands.ts), so menus, toolbars and the
 * project window just run the command.
 */
import { useState } from 'react';
import { useIdeCommand } from '../commands';
import { AboutDialog, FindAndOpenDialog, PreferencesDialog, ProjectInspectorDialog, RemoveObjectCodeDialog, StartupDialog } from './MiscDialogs';
import { NewProjectDialog } from './NewProjectDialog';
import { TargetSettingsDialog } from './TargetSettingsDialog';

export interface IdeDialogsProps {
  /** Status-bar message sink (Remove Object Code result...). */
  onStatus?: (msg: string) => void;
  /** File selected in the project window (Project Inspector default). */
  selectedFile?: string | null;
}

export function IdeDialogs({ onStatus, selectedFile = null }: IdeDialogsProps) {
  const [about, setAbout] = useState(false);
  const [settings, setSettings] = useState<{ target?: string } | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [removeObj, setRemoveObj] = useState(false);
  const [inspect, setInspect] = useState<{ name: string | null } | null>(null);
  const [prefs, setPrefs] = useState(false);
  const [startup, setStartup] = useState(false);
  const [findOpen, setFindOpen] = useState(false);

  useIdeCommand('help.about', () => setAbout(true));
  useIdeCommand('project.settings', (a) => setSettings({ target: a?.target }));
  useIdeCommand('project.new', () => setNewProject(true));
  useIdeCommand('project.removeObjectCode', () => setRemoveObj(true));
  useIdeCommand('project.inspect', (a) => setInspect({ name: a?.name ?? selectedFile }));
  useIdeCommand('app.preferences', () => setPrefs(true));
  useIdeCommand('app.startup', () => setStartup(true));
  useIdeCommand('file.findAndOpen', () => setFindOpen(true));

  return (
    <>
      <AboutDialog open={about} onClose={() => setAbout(false)} />
      <TargetSettingsDialog open={settings !== null} target={settings?.target} onClose={() => setSettings(null)} />
      <NewProjectDialog open={newProject} onClose={() => setNewProject(false)} />
      <RemoveObjectCodeDialog open={removeObj} onClose={() => setRemoveObj(false)} onDone={(m) => onStatus?.(m)} />
      <ProjectInspectorDialog open={inspect !== null} name={inspect?.name ?? null} onClose={() => setInspect(null)} />
      <PreferencesDialog open={prefs} onClose={() => setPrefs(false)} />
      <StartupDialog open={startup} onClose={() => setStartup(false)} />
      <FindAndOpenDialog open={findOpen} onClose={() => setFindOpen(false)} />
    </>
  );
}
