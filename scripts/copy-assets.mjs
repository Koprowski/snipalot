// Copy static HTML / CSS / image assets into dist/ so Electron can find them
// relative to the compiled JS at runtime.

import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcRoot = join(root, 'src');
const distRoot = join(root, 'dist');

const COPY_EXTENSIONS = new Set(['.html', '.css', '.png', '.svg', '.ico', '.json']);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  if (!existsSync(srcRoot)) {
    console.error(`[copy-assets] src not found at ${srcRoot}`);
    process.exit(1);
  }
  const files = await walk(srcRoot);
  let copied = 0;
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'));
    if (!COPY_EXTENSIONS.has(ext)) continue;
    const rel = relative(srcRoot, file);
    const dest = join(distRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(file, dest);
    copied += 1;
  }
  console.log(`[copy-assets] copied ${copied} files → dist/`);
}

main().catch((err) => {
  console.error('[copy-assets] failed:', err);
  process.exit(1);
});
