export const appDir: string;
export const repoDir: string;
export const localLibDir: string;
export function electronPath(): string;
export function electronEnv(extra?: Record<string, string>): Record<string, string | undefined>;
export function electronArgs(): string[];
export function isWsl(): boolean;
