import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Seeds the backend dev DB with realistic-looking M0 data for screenshots.
 * Forwards to the backend's `db:seed-screenshots` script. Backend's
 * `DATABASE_URL` (loaded via --env-file=.env in that script) decides which
 * Postgres gets seeded.
 */
export function runSeedScreenshots(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = spawnSync('bun', ['run', '--filter', 'backend', 'db:seed-screenshots'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`seed-screenshots failed (exit ${result.status ?? 'unknown'})`);
  }
}
