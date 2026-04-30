import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const checks = [
  {
    label: 'Whisper CLI executable',
    paths: [
      join(root, 'resources', 'bin', 'whisper', 'whisper-cli.exe'),
      join(root, 'resources', 'bin', 'whisper', 'main.exe'),
    ],
    minBytes: 20_000,
  },
  {
    label: 'Whisper base.en model',
    paths: [join(root, 'resources', 'models', 'ggml-base.en.bin')],
    minBytes: 100_000_000,
  },
];

let ok = true;

for (const check of checks) {
  const found = check.paths.find((p) => existsSync(p) && statSync(p).size >= check.minBytes);
  if (found) {
    const sizeMb = (statSync(found).size / 1_000_000).toFixed(1);
    console.log(`[resources] OK ${check.label}: ${found} (${sizeMb} MB)`);
    continue;
  }
  ok = false;
  console.error(`[resources] MISSING ${check.label}`);
  for (const p of check.paths) {
    const size = existsSync(p) ? statSync(p).size : 0;
    console.error(`  - ${p} (${size} bytes)`);
  }
}

if (!ok) {
  console.error('\nRun `npm run fetch-resources` before packaging. Installers must include Whisper.');
  process.exit(1);
}
