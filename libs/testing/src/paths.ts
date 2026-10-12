import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const repoPath = (relative: string): string => `${REPO_ROOT}${relative}`;
