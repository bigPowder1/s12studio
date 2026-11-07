/** IPC channel naming shared by preload and main. */
import type { Domain } from './api';

/** ipcRenderer.invoke channel of a request method. */
export const invokeChannel = (domain: Domain, method: string): string => `s12:${domain}.${method}`;

/** Single event channel: webContents.send(EVENT_CHANNEL, domain, event, payload). */
export const EVENT_CHANNEL = 's12:evt';

/** Command-line / environment flags understood by main (see src/main/cli.ts). */
export const E2E_ENV = 'S12_E2E';
