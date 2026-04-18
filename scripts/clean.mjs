import { rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

for (const dir of ['dist', 'release', 'spike-output']) {
  await rm(join(root, dir), { recursive: true, force: true });
  console.log(`[clean] removed ${dir}/`);
}
