import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Resolve the Gemini CLI binary for spawn(..., { shell: false }).
 *
 * On Windows, global npm shims are usually `gemini.cmd`; `spawn('gemini')`
 * often returns ENOENT unless we pass the concrete path from `where.exe`.
 */
export interface GeminiCliSpawnTarget {
  command: string;
  prefixArgs: string[];
}

/**
 * Path to our ESM shim that fixes up process.argv + process.defaultApp
 * before delegating to gemini-cli's bundle. This avoids the yargs
 * "phantom positional" bug that triggers when running through electron.exe
 * with ELECTRON_RUN_AS_NODE=1. The shim lives next to this compiled JS
 * file in dist/main/.
 */
const SHIM_PATH = path.join(__dirname, 'gemini-cli-shim.mjs');

export function resolveGeminiCliExecutable(cliCommand: string): GeminiCliSpawnTarget {
  const raw = (cliCommand || 'gemini').trim() || 'gemini';
  // Users sometimes paste quoted paths in settings; spawn() expects raw path.
  const trimmed = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  const asTarget = (command: string, prefixArgs: string[] = []): GeminiCliSpawnTarget => ({ command, prefixArgs });
  const ext = path.extname(trimmed).toLowerCase();
  const cmdLikeExt = ext === '.cmd' || ext === '.bat';

  // When running via process.execPath we want: [shim, geminiBundle, ...args].
  // The shim path is prepended only when it actually exists on disk (it
  // ships in dist/main/ via copy-assets.mjs but a stale build could miss it).
  const wrapWithShim = (geminiEntry: string): GeminiCliSpawnTarget =>
    fs.existsSync(SHIM_PATH)
      ? asTarget(process.execPath, [SHIM_PATH, geminiEntry])
      : asTarget(process.execPath, [geminiEntry]);

  const tryNodeEntryFromShim = (shimPath: string): GeminiCliSpawnTarget | null => {
    const shimDir = path.dirname(shimPath);
    const pkgRoot = path.join(shimDir, 'node_modules', '@google', 'gemini-cli');
    // Prefer reading the package's package.json `bin` field — this survives
    // future repackaging (the actual entry has moved across versions:
    //   v0.x: dist/index.js
    //   v0.40+: bundle/gemini.js
    // ).
    try {
      const pkgJsonPath = path.join(pkgRoot, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
          bin?: string | Record<string, string>;
          main?: string;
        };
        const binEntry =
          typeof pkg.bin === 'string'
            ? pkg.bin
            : (pkg.bin && (pkg.bin.gemini ?? Object.values(pkg.bin)[0])) ?? pkg.main;
        if (binEntry) {
          const resolved = path.join(pkgRoot, binEntry);
          if (fs.existsSync(resolved)) {
            return wrapWithShim(resolved);
          }
        }
      }
    } catch {
      // fall through to static candidates
    }
    // Static fallback in case package.json read failed.
    const candidates = [
      path.join(pkgRoot, 'bundle', 'gemini.js'),
      path.join(pkgRoot, 'dist', 'index.js'),
      path.join(pkgRoot, 'bin', 'gemini.js'),
      path.join(pkgRoot, 'index.js'),
    ];
    const entry = candidates.find((p) => fs.existsSync(p));
    if (!entry) return null;
    return wrapWithShim(entry);
  };

  if (path.isAbsolute(trimmed)) {
    if (fs.existsSync(trimmed)) {
      if (process.platform === 'win32' && cmdLikeExt) {
        return tryNodeEntryFromShim(trimmed) ?? asTarget(trimmed);
      }
      return asTarget(trimmed);
    }
    const withCmd = `${trimmed}.cmd`;
    if (fs.existsSync(withCmd)) {
      return tryNodeEntryFromShim(withCmd) ?? asTarget(withCmd);
    }
    const withExe = `${trimmed}.exe`;
    if (fs.existsSync(withExe)) return asTarget(withExe);
    // If user pasted a full path without extension, prefer .cmd shim on Win.
    if (process.platform === 'win32' && !ext) {
      return asTarget(withCmd);
    }
    return asTarget(trimmed);
  }
  if (trimmed.includes(path.sep) || trimmed.includes('/')) {
    if (process.platform === 'win32' && !ext) {
      return asTarget(`${trimmed}.cmd`);
    }
    return asTarget(trimmed);
  }
  if (process.platform !== 'win32') {
    return asTarget(trimmed);
  }
  const tryWhere = (name: string): string | null => {
    try {
      const stdout = execSync(`where.exe ${name}`, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // npm globally installs gemini as 3 files in the same folder:
      //   gemini       (bash shim — Windows spawn can't run shebangs)
      //   gemini.cmd   (Windows native shim — what we want)
      //   gemini.ps1   (PowerShell shim)
      // `where.exe gemini` returns ALL of them, with the extensionless
      // bash script LISTED FIRST. Walk every line and prefer .cmd/.exe/.bat
      // before falling back to whatever was first. Picking the bash script
      // gives ENOENT because Windows can't natively execute shebangs.
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const preferred = lines.find((p) => /\.(cmd|exe|bat)$/i.test(p) && fs.existsSync(p));
      if (preferred) return preferred;
      const first = lines.find((p) => fs.existsSync(p));
      if (first) return first;
    } catch {
      // not found
    }
    return null;
  };
  // On Windows, ask `where.exe` directly for `name.cmd` first so we never
  // see the extensionless bash variant in the output at all.
  const fromWhere = tryWhere(`${trimmed}.cmd`)
    ?? tryWhere(`${trimmed}.exe`)
    ?? tryWhere(trimmed);
  if (fromWhere) {
    const isCmd = fromWhere.toLowerCase().endsWith('.cmd') || fromWhere.toLowerCase().endsWith('.bat');
    if (isCmd) return tryNodeEntryFromShim(fromWhere) ?? asTarget(fromWhere);
    return asTarget(fromWhere);
  }

  // Fallback for packaged apps where PATH may omit npm global shims.
  const appData = process.env.APPDATA;
  if (appData) {
    const npmShim = path.join(appData, 'npm', `${trimmed}.cmd`);
    if (fs.existsSync(npmShim)) {
      return tryNodeEntryFromShim(npmShim) ?? asTarget(npmShim);
    }
  }
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const npmShim = path.join(userProfile, 'AppData', 'Roaming', 'npm', `${trimmed}.cmd`);
    if (fs.existsSync(npmShim)) {
      return tryNodeEntryFromShim(npmShim) ?? asTarget(npmShim);
    }
  }

  return asTarget(trimmed);
}
