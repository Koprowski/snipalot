// Snipalot ↔ Gemini CLI shim.
//
// We spawn `gemini-cli` from inside Electron via the Electron binary with
// ELECTRON_RUN_AS_NODE=1 so we don't need a separate Node install. The
// catch: `gemini-cli` uses yargs, and yargs has a heuristic in `hideBin`
// that detects "running inside an Electron-bundled app" by checking
//   `process.versions.electron && !process.defaultApp`.
// When that heuristic fires, yargs slices only argv[0] from process.argv
// instead of argv[0] AND argv[1]. The script path then surfaces as a
// phantom positional, which collides with `--prompt` and triggers
//   "Cannot use both a positional prompt and the --prompt flag together".
//
// The fix is to (a) set `process.defaultApp = true` so yargs treats this
// as a "default app" (dev-mode Electron) and slices both bin entries,
// and (b) splice this shim's own path out of process.argv so when yargs
// slices argv[0] it leaves only the user args. argv[2] is the gemini
// bundle entry path; the shim removes both that and itself from argv,
// then dynamically imports the bundle.
//
// Usage:
//   spawn(electronExe, [shimPath, geminiBundlePath, ...userArgs], { env: { ELECTRON_RUN_AS_NODE: '1', ... } })

import { pathToFileURL } from 'node:url';

const DEBUG = process.env.SNIPALOT_GEMINI_SHIM_DEBUG === '1';
const dlog = (...args) => { if (DEBUG) console.error('[shim]', ...args); };

dlog('start argv:', JSON.stringify(process.argv));
dlog('process.versions.electron:', process.versions.electron);
dlog('process.defaultApp before:', process.defaultApp);

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('[snipalot/gemini-cli-shim] missing bundle path argument (argv[2])');
  process.exit(2);
}

// Trick yargs.hideBin into the non-bundled-Electron path BEFORE we touch
// argv. yargs reads `process.versions.electron && !process.defaultApp` to
// decide whether to slice 1 or 2 entries off argv.
Object.defineProperty(process, 'defaultApp', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: true,
});

// Normalise argv to what yargs expects under a regular Node invocation:
//   [exec, scriptPath, ...userArgs]
// Remove argv[1] (this shim's own path) so the gemini bundle path becomes
// argv[1]. We mutate the existing array in-place so any consumer that
// captured a reference to process.argv sees the change too.
process.argv.splice(1, 1);

dlog('after fixup argv:', JSON.stringify(process.argv));
dlog('process.defaultApp after:', process.defaultApp);

// Hand off to gemini-cli's actual entry. ESM dynamic import requires a
// file:// URL on Windows.
await import(pathToFileURL(bundlePath).href);
