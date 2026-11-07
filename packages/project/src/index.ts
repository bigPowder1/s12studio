/**
 * @s12/project: the IDE's project model (.mcp + '<name>.s12studio.json' sidecar) and build ("Make") orchestration.
 * Pure TS; all file access goes through an injected ProjectFs (Node and in-memory implementations included).
 */
export * from './fs';
export * from './paths';
export { hashBytes, hashText } from './hash';
export * from './kinds';
export * from './sidecar';
export * from './model';
export * from './build';
export * from './compiler-root';
export * from './templates';
