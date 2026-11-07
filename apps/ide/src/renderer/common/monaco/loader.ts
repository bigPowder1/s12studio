/**
 * Lazy Monaco loader shared by the IDE editor and the debugger Source view.
 *
 *   const monaco = useMonaco();            // null until loaded
 *   const monaco = await loadMonaco();     // registers the HC12 language + CW themes once
 *
 * Tests swap the implementation with `setMonacoLoader(() => Promise.resolve(fake))` (jsdom cannot run the editor
 * widget; testing/fakeMonaco.ts is a small stand-in).
 */
import { useEffect, useState } from 'react';
import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import { HC12_LANGUAGE_ID, HC12_EXTENSIONS, hc12LanguageConfiguration, hc12Monarch } from './hc12';
import { applyCwKeybindings } from './keybindings';
import { MONACO_THEMES } from './themes';

export type Monaco = typeof MonacoNs;

async function defaultLoader(): Promise<Monaco> {
  const [monaco, worker] = await Promise.all([import('./monaco-bundle'), import('monaco-editor/editor/editor.worker?worker')]);
  const EditorWorker = worker.default;
  (self as unknown as { MonacoEnvironment: MonacoNs.Environment }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
  return monaco as unknown as Monaco;
}

let loader: () => Promise<Monaco> = defaultLoader;
let pending: Promise<Monaco> | null = null;
let loaded: Monaco | null = null;
const registered = new WeakSet<object>();

/** Register the HC12 language, its tokenizer and the CW themes on a Monaco instance (idempotent). */
export function registerHc12(monaco: Monaco): void {
  if (registered.has(monaco)) return;
  registered.add(monaco);
  monaco.languages.register({ id: HC12_LANGUAGE_ID, extensions: HC12_EXTENSIONS, aliases: ['HC12 Assembly', 'hc12', 'asm'] });
  monaco.languages.setMonarchTokensProvider(HC12_LANGUAGE_ID, hc12Monarch);
  monaco.languages.setLanguageConfiguration(HC12_LANGUAGE_ID, hc12LanguageConfiguration);
  for (const [name, data] of Object.entries(MONACO_THEMES)) monaco.editor.defineTheme(name, data);
}

export function loadMonaco(): Promise<Monaco> {
  if (!pending) {
    pending = loader().then((m) => {
      registerHc12(m);
      applyCwKeybindings(m);
      loaded = m;
      return m;
    });
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/** The loaded instance, if any (synchronous access for event handlers). */
export function loadedMonaco(): Monaco | null {
  return loaded;
}

/** Tests: replace the loader (null restores the real one) and forget the cached instance. */
export function setMonacoLoader(fn: (() => Promise<Monaco>) | null): void {
  loader = fn ?? defaultLoader;
  pending = null;
  loaded = null;
}

/** React: the Monaco namespace once loaded (null while loading or after a load error, logged once). */
export function useMonaco(): Monaco | null {
  const [m, setM] = useState<Monaco | null>(loaded);
  useEffect(() => {
    if (m) return;
    let live = true;
    loadMonaco().then(
      (x) => {
        if (live) setM(x);
      },
      (e) => console.error('Monaco failed to load', e),
    );
    return () => {
      live = false;
    };
  }, [m]);
  return m;
}
