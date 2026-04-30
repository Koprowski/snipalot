# Snipalot — agent handoff notes

Use this file to onboard LLMs or humans picking up work without full chat context.

## Repo snapshot

- **Stack:** Electron 30, TypeScript (strict), main process in `src/main/index.ts`, renderers under `src/*`, post-processing in `src/main/pipeline.ts` and `src/main/trade-pipeline.ts`.
- **Build:** `npm ci` then `npm run build`. Run app: `npm run dev`.
- **Windows installer (local):** On a Windows machine, `npm run package` produces **`release/Snipalot-<version>-setup.exe`** (see `electron-builder.yml`). `package:portable` builds the portable exe.
- **Windows installer (CI / publishing):** Pushing a git tag matching **`v*`** (e.g. `v1.0.7`) runs **`.github/workflows/release-windows.yml`**, which runs **`npm ci`**, **`npm run fetch-resources`** (Whisper + model into `resources/`), then **`npm run package:nopublish`** on `windows-latest`, then **`softprops/action-gh-release`** uploads **`release/Snipalot-*-setup.exe`**. Bump **`package.json` `version`** before tagging so the artifact name matches the release.
- **Linux:** `npm run package` on Linux produces AppImage/Snap only, not the Windows setup exe.
- **End-user install:** **[GitHub Releases](https://github.com/Koprowski/snipalot/releases)** — download the latest **`Snipalot-*-setup.exe`**. Full Trade + Gemini guide: **`docs/installation-guide-issue-2.md`** (mirror for **[Issue #2](https://github.com/Koprowski/snipalot/issues/2)** — paste that file into the issue when the download URL changes; API tokens may not edit issues).
- **Config:** `%USERPROFILE%\.snipalot\config.json`; defaults in `src/main/config.ts`.

## Recent improvements (v1.0.1 onward; current release v1.0.7)

- **Fullscreen + screen share:** Before `getDisplayMedia`, main **lowers overlay alwaysOnTop** so Windows’ “what to share” dialog is not hidden behind the Snipalot overlay; then restores `screen-saver` level.
- **Recorder logs in snipalot.log:** Recorder renderer lines are forwarded to main **`log('recorder', …)`** so `%APPDATA%\\Snipalot\\logs\\snipalot.log` shows `getDisplayMedia` progress without `--debug`.
- **Packaged tray + Whisper paths:** Tray icons and Whisper lookup prefer **`process.resourcesPath/resources`** (not `cwd` under Program Files).
- **Processing / trade stalls:** If `save-webm` never arrives or Whisper hangs, a **processing watchdog** returns the launcher to idle with a toast (and Whisper is killed after 25 min). Trade-mode **MockApe wait** defaults to **3 minutes** then proceeds without trade data (was 30 min).
- **`mic_diagnostics.json`** in each **record/trade** session folder when recording starts: `getUserMedia` success/failure, active audio track label + `deviceId` (when exposed), `enumerateDevices` snapshot for `audioinput`. Main logs a one-line **`recorder` / `mic capture summary`**. Use for “no audio” / wrong-default-mic support (Snipalot still uses OS default input; no in-app mic picker yet).
- **Frame picker:** Export uses `recording.mp4` inside the session directory (not the parent folder).
- **Hotkeys:** README, launcher hints, and logs aligned with `config.ts` (e.g. trade marker `Ctrl+Shift+M`, trade toggle `Ctrl+Shift+T`).
- **Snapshots:** Serialized in main so concurrent 📸 cannot cross-wire `recorder:snap-result`.
- **Settings:** Folder picker avoids a forced parent window when settings is closed.
- **Docs:** README links Releases + Issue #2 for exe vs dev install; production build uses `npm run package` → **`release/`**.
- **Dependency security refresh (local branch):** `electron` upgraded to `^41.3.0` and `electron-builder` to `^26.8.1`, with lockfile regenerated to clear audit findings.
- **Settings reliability fixes (local branch):** Settings preload/renderer/main IPC wiring now aligns for API-test and update-check flows (`testApiKeys`, `openLatestRelease`, and version label id mapping).
- **Settings UX additions (local branch):** Added footer **Exit Snipalot** action that requests app shutdown from main, plus targeted Windows cleanup for Snipalot-associated sibling `electron.exe` processes (command-line path filtered, avoids killing unrelated Electron apps).
- **Window-X exit parity (local branch):** Closing the launcher/settings via X (including Alt+F4 close events) now routes through the same main-process exit path as **Settings → Exit Snipalot**, preserving the existing Windows sibling-process filtering cleanup.
- **Trade extraction backend mode (local branch):** Added config + Settings controls for `trade.llmMode`:
  - `gemini-cli` (default): headless local Gemini CLI call (`gemini -p ... --model ... --output-format json`)
  - `api` (optional): OpenRouter/OpenAI-compatible HTTP extraction path.
- **Gemini API key option removed (local branch):** Trade settings no longer expose/store a Gemini API key. Config now uses:
  - Gemini CLI (`geminiCliCommand`, `geminiCliModel`) for preferred local mode
  - OpenRouter/OpenAI-compatible API key + base URL + model for optional API mode and API key tests.
- **Unified Settings connection test (local branch):** Consolidated testing into one button: **`Test LLM Connection`**.
  - In `gemini-cli` mode: verifies command/model and runs a lightweight headless CLI invocation.
  - In `api` mode: tests OpenRouter/OpenAI-compatible API key + base URL + model.
  - Status text is now mode-aware and explicit about what was tested.
- **Gemini defaults refreshed (local branch):** OpenAI-compatible model defaults moved from deprecated `google/gemini-2.0-flash-exp:free` toward `google/gemini-2.5-flash` in settings/config fallback text and pipeline defaults.
- **OpenRouter model browser in Settings (local branch):** Added `Fetch Models` + searchable filter + selectable model list (latest-first sort by created date) beside the API model field. Main process now fetches `https://openrouter.ai/api/v1/models` and caches results under user data for graceful offline fallback.
- **OpenRouter cost filters (local branch):** Model picker now shows input pricing and supports `Free only` + `Max input $/1M` filtering to quickly narrow to no-cost or budget-capped options.
- **Gemini CLI + Settings layout fixes (local branch):**
  - Gemini CLI invocation updated to pass the prompt as a positional argument (not `-p`) for compatibility with newer CLI behavior.
  - Settings window default size increased and made resizable (`760x700`, min `700x620`) so newer controls no longer clip/chop in tighter layouts.
- **Gemini trust-mode + settings spacing hardening (local branch):**
  - Gemini CLI calls now set `GEMINI_CLI_TRUST_WORKSPACE=true` by default in spawned environment (connection test, model listing, and trade auto-extraction) to avoid trusted-directory failures in app-driven invocations.
  - Settings stylesheet now enforces wider consistent side padding and robust text wrapping in lower sections/footer so long status/errors do not visually collapse edge spacing.
- **Settings exit UX simplified (local branch):** Removed redundant footer `Exit Snipalot` button; Settings window close (`X`) remains the full-exit path with the same app shutdown cleanup behavior.
- **Launcher shortcut UX + spacing refresh (local branch):**
  - Reduced launcher vertical whitespace by tightening content spacing and lowering launcher window height (`156`).
  - Replaced single generic shortcut hint with per-action shortcut labels centered under each button (Record/Screenshot/Trade), plus guidance text below.
  - Launcher state payload now includes `snapshotHotkey` and `startTradeHotkey` so shortcut labels stay in sync with user-customized config.
- **Gemini CLI test hardening (local branch):**
  - Settings `Test LLM Connection` in `gemini-cli` mode now runs staged probes (`--version`, `models --json`, then prompt probe) for clearer diagnostics and fewer false negatives.
  - Prompt invocations now use explicit `--prompt` (not positional) in both settings test and trade auto-extraction paths.
  - Gemini CLI spawns use `shell: false` on Windows so multi-word `--prompt` values are not split by `cmd.exe` (avoids false "positional + --prompt" errors).
  - Windows: `resolveGeminiCliExecutable()` uses `where.exe` to locate `gemini.cmd` / `gemini.exe` so `shell:false` spawns do not `ENOENT` on npm global shims.
  - Windows fallback: if PATH lookup fails, resolver now checks common npm shim locations (`%APPDATA%\\npm\\gemini.cmd` and `%USERPROFILE%\\AppData\\Roaming\\npm\\gemini.cmd`) to avoid requiring manual command-path setup.
  - Resolver now returns a spawn target (`command` + `prefixArgs`) and, when only a `.cmd` shim is found, launches the underlying Gemini CLI JS entry via `node` to avoid Windows `.cmd` `EINVAL` with direct `spawn(..., shell:false)`.
  - Gemini command parsing now strips wrapping quotes from user-entered command paths, and Gemini spawn helpers guard sync `spawn()` exceptions so IPC returns actionable launch errors instead of crashing with raw `spawn EINVAL`.
- **Settings close semantics corrected (local branch):** Settings window `X`/Cancel now only closes Settings and refocuses launcher; full process shutdown remains tied to the primary launcher `X`/quit path.
- **Windows quit-cleanup PowerShell fix (local branch):** Corrected sibling `electron.exe` filter command generation in `killSiblingSnipalotElectronProcesses()` to avoid `-and` parser errors; shutdown cleanup now uses a valid single-clause `Where-Object` predicate.
- **Gemini CLI settings-test fallback + diagnostics (local branch):**
 - `settings:test-llm-connection` now retries the prompt probe with a positional prompt when Gemini returns the known "`--prompt` + positional" parser conflict, preventing false negatives from runtime argv quirks.
 - Added structured, non-secret `settings` logs for each Gemini test stage (launch/version/prompt/fallback success/failure) with sanitized stderr tails for faster root-cause support.
- **Missing Gemini CLI guidance in Settings test (local branch):**
 - `Test LLM Connection` now classifies missing-CLI launch failures (`ENOENT`/not-found patterns) and returns a mode-specific guidance payload from main (install command + docs URL).
 - Settings now shows a compact "Gemini CLI not installed" help card with one-click **Open install guide** and **Copy** install command actions; successful test behavior remains unchanged.
- **Recorder start handshake hardening (local branch):**
 - Main now tracks recorder-renderer readiness (`recorder:ready`) and queues `recorder:start` if the renderer is not yet ready, then flushes once ready so Record/Trade cannot silently drop the start IPC.
 - Added recorder-window diagnostics (`did-finish-load`, `did-fail-load`, `render-process-gone`) to `snipalot.log` for direct evidence when the hidden recorder fails to load or crashes.
- **Recorder shortcut-start fail-safe + persistent issue log (local branch):**
 - Added fallback start dispatch after recorder `did-finish-load` when `recorder:ready` has not arrived, plus a 5s readiness timeout that resets to idle with a user-facing notification instead of silently hanging.
 - Added `docs/recording-shortcuts-issue-log.md` as the persistent troubleshooting ledger for this recurring hotkey/recording startup issue.
- **Recorder renderer bootstrap fix (local branch):**
 - Runtime logs showed `recorder window finished load` followed by queued start timeout and no `recorder:ready`; compiled `dist/recorder/recorder.js` contained CommonJS `exports` boilerplate because `src/recorder/recorder.ts` had a type-only import.
 - Fixed by replacing the recorder renderer type import with local interfaces so the compiled browser script has no `exports`/`require`; added recorder `console-message` and `preload-error` forwarding in main so future renderer bootstrap failures appear in `snipalot.log`.
- **Local Whisper install + transcript troubleshooting (2026-04-30):**
 - Missing transcript was not an audio-capture issue; latest run logged `whisper.cpp + model not installed — run npm run fetch-resources`.
 - Ran `npm run fetch-resources`, which installed `resources/bin/whisper/whisper-cli.exe` and `resources/models/ggml-base.en.bin`; manual ffmpeg + Whisper test against `E:\Video Screencasts\recording.mp4` succeeded and produced transcript text.
 - Future dev runs should transcribe automatically; if not, inspect `pipeline` / `whisper` logs and confirm resources still exist under `resources/bin/whisper` + `resources/models`.
- **Installer Whisper bundling hardening (local branch):**
 - Packaging scripts now run `kill:stale`, `fetch-resources`, `build`, and `assert-resources` before `electron-builder`; `scripts/assert-resources.mjs` fails packaging if `whisper-cli.exe`/`main.exe` or `ggml-base.en.bin` is missing.
 - `electron-builder.yml` was updated for `electron-builder@26` compatibility (`win.sign` removed, `nsis.warningsAsErrors=false` for bundled NSIS template warning). A fresh-output NSIS build succeeded and verified Whisper/model are present under packaged `resources/resources/...`; default `release/` may still be locally file-locked by Windows until handles clear.
- **Review-priority follow-ups (local branch):**
 - Completed: `settings:save` now logs `sanitizeSettingsPartialForLog(partial)` so `trade.openaiApiKey` is redacted in `snipalot.log`; Trade auto-extraction now retries with a positional prompt after Gemini CLI's known "`--prompt` + positional" parser conflict, matching Settings test behavior.
 - Recorder shortcut fail-safe passed build/static review and Pass 3 was appended to `docs/recording-shortcuts-issue-log.md`; still needs hands-on runtime validation for both `Ctrl+Shift+S` and `Ctrl+Shift+T` with exact log lines.
 - After those, clean up user-facing mismatches: make Trade hotkeys editable in Settings, align launcher-X docs/tooltips with the current full-exit behavior, propagate config write errors to Settings instead of silently closing, and refresh `docs/installation-guide-issue-2.md` for Gemini CLI/OpenRouter mode (no removed Gemini API key field).

## Packaged app logs

Main logger writes **`snipalot.log`** under Electron’s **`logs`** path (e.g. Windows: `%APPDATA%\Snipalot\logs\snipalot.log`). **Dev** builds still use **`./spike-output/snipalot.log`** next to the repo cwd. If unsure, search the PC for **`snipalot.log`**.

## Open items — intentional deferrals

These came from code review; **not** implemented yet. Pick up as separate tasks if desired.

1. **Unexpected recorder stop** (`recorder:state` → `stopped` while `appState === 'recording'`): Main snapshots `pendingProcessing` and goes to `idle` but does not mirror full `stopRecording()` (processing UI, trade-context window, etc.). Decide product behavior before changing.

2. **IPC payload limits:** Optional caps / validation on renderer-supplied payloads.

3. **Split `src/main/index.ts`:** Large file; splitting by concern would help maintainability.

4. **Dependency / security audit:** `npm audit` upstream noise; dedicated pass if required.

5. **Automated tests:** No `npm test` yet; good candidates: pipeline helpers, path logic.

6. **In-app microphone device picker:** Diagnostics exist; explicit device selection in Settings still deferred.

7. **Shortcut-triggered recording startup reliability:** Mitigations landed (queued-start fallback + timeout) and build/static verification passed, but runtime validation across both hotkeys (`Ctrl+Shift+S` and `Ctrl+Shift+T`) remains in progress; track detailed passes in `docs/recording-shortcuts-issue-log.md`.

## Conventions

- Prefer matching existing patterns in nearby files (IPC naming `channel:verb`, `contextIsolation`, preload bridges).
- Avoid drive-by refactors unrelated to the task.
- User rule: Gradle builds use `--scan` — **not applicable** here (Node/Electron).

## Agent workflow memory

- **Always update this `AGENTS.md` file at the end of significant implementation sessions** (new feature work, behavior changes, config/schema changes, release/build workflow changes, or major troubleshooting outcomes). Keep entries concise and action-oriented so the next agent can continue without chat history.

## Useful paths

| Area | Path |
|------|------|
| App entry / lifecycle | `src/main/index.ts` |
| Feedback + trade pipeline | `src/main/pipeline.ts`, `src/main/trade-pipeline.ts` |
| Mic diagnostics types | `src/shared/mic-diagnostics.ts` |
| Config | `src/main/config.ts` |
| Windows release CI | `.github/workflows/release-windows.yml` |
| NSIS installer hooks | `resources/installer.nsh` (`customCheckAppRunning` — more patient app-exit during upgrade) |
| Product doc | `README.md`, `snipalot_PRD.md` |
| End-user install guide (Issue #2 mirror) | `docs/installation-guide-issue-2.md` |
