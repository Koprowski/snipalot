// Download the whisper.cpp Windows binary and the base.en model into
// resources/ so the pipeline can run transcription. Run once per machine:
//
//   npm run fetch-resources
//
// Total download is ~150 MB (the model is the big one; the binary is
// a few MB). Both land under:
//
//   resources/bin/whisper/whisper-cli.exe
//   resources/models/ggml-base.en.bin
//
// Neither is committed to the repo (both are in .gitignore). A packaging
// step later will pull from this same layout into the electron-builder
// extraResources path.

import { mkdir, writeFile, stat, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const resourcesDir = join(root, 'resources');
const binDir = join(resourcesDir, 'bin', 'whisper');
const modelsDir = join(resourcesDir, 'models');

const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const MODEL_PATH = join(modelsDir, 'ggml-base.en.bin');

// whisper.cpp Windows release. The CPU build is the most compatible; GPU
// builds exist (blas / cuda / vulkan) but require matching runtime libs.
//
// The "bin-x64" zip contains whisper-cli.exe and a few DLLs. We unpack
// everything into resources/bin/whisper/.
const WHISPER_RELEASE_TAG = 'v1.8.4';
const WHISPER_ZIP_NAME = 'whisper-blas-bin-x64.zip';
const WHISPER_ZIP_URL = `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_RELEASE_TAG}/${WHISPER_ZIP_NAME}`;
const WHISPER_ZIP_PATH = join(binDir, WHISPER_ZIP_NAME);

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function fileSize(p) {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

async function downloadTo(url, dest) {
  console.log(`[fetch] GET ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  await ensureDir(dirname(dest));
  const out = createWriteStream(dest);
  let got = 0;
  let lastReport = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(value);
    got += value.byteLength;
    if (total && got - lastReport > total / 20) {
      lastReport = got;
      const pct = ((got / total) * 100).toFixed(1);
      process.stdout.write(`  ${pct}%  (${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)\r`);
    }
  }
  out.end();
  await new Promise((r) => out.on('finish', r));
  if (total) process.stdout.write('\n');
  console.log(`[fetch] → ${dest} (${(got / 1e6).toFixed(1)} MB)`);
}

async function ensureModel() {
  if ((await fileSize(MODEL_PATH)) > 100_000_000) {
    console.log(`[model] already present: ${MODEL_PATH}`);
    return;
  }
  console.log(`[model] downloading ggml-base.en (~148 MB)…`);
  await downloadTo(MODEL_URL, MODEL_PATH);
}

async function ensureWhisperBinary() {
  // If whisper-cli.exe already exists, skip.
  const cliPath = join(binDir, 'whisper-cli.exe');
  const mainPath = join(binDir, 'main.exe');
  if (existsSync(cliPath) || existsSync(mainPath)) {
    console.log(`[whisper] binary already present in ${binDir}`);
    return;
  }

  console.log(`[whisper] downloading ${WHISPER_RELEASE_TAG} Windows binary…`);
  await ensureDir(binDir);
  await downloadTo(WHISPER_ZIP_URL, WHISPER_ZIP_PATH);

  // Unzip using PowerShell on Windows (no extra deps). On non-Windows this
  // script isn't useful anyway.
  console.log(`[whisper] extracting…`);
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${WHISPER_ZIP_PATH}" -DestinationPath "${binDir}" -Force`,
      ],
      { stdio: 'inherit' }
    );
    ps.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Expand-Archive exited ${code}`));
    });
  });

  // The zip extracts into a subdirectory (e.g. whisper-bin-x64/). Flatten
  // everything into binDir.
  const entries = await readdir(binDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'whisper' || entry.name.startsWith('.')) continue;
    const nested = join(binDir, entry.name);
    const nestedEntries = await readdir(nested);
    for (const name of nestedEntries) {
      await rename(join(nested, name), join(binDir, name));
    }
    await rm(nested, { recursive: true, force: true });
  }
  await rm(WHISPER_ZIP_PATH, { force: true });

  const ok = existsSync(join(binDir, 'whisper-cli.exe')) || existsSync(join(binDir, 'main.exe'));
  if (!ok) {
    throw new Error(
      `extraction finished but no whisper binary found in ${binDir}. Contents: ${(await readdir(binDir)).join(', ')}`
    );
  }
  console.log(`[whisper] ready in ${binDir}`);
}

async function main() {
  await ensureDir(resourcesDir);
  await ensureDir(modelsDir);
  await ensureDir(binDir);
  await ensureWhisperBinary();
  await ensureModel();
  console.log('\nDone. Run `npm run spike:m1` and transcription will be picked up automatically.');
}

main().catch((err) => {
  console.error('[fetch-resources] failed:', err);
  process.exit(1);
});
