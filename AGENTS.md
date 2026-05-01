# Snipalot — agent handoff notes

Use this file to onboard LLMs or humans picking up work without full chat context.

## Repo snapshot

- **Stack:** Electron 41, TypeScript (strict), main process in `src/main/index.ts`, renderers under `src/*`, post-processing in `src/main/pipeline.ts` and `src/main/trade-pipeline.ts`.
- **Build:** `npm ci` then `npm run build`. Run app: `npm run dev`.
- **Windows installer (local):** On a Windows machine, `npm run package` produces the default **light installer** at **`release/Snipalot-<version>-setup.exe`** (see `electron-builder.yml`). `package:portable` builds the portable exe. Use `npm run package:full` only when intentionally building a large bundled-Whisper installer from `electron-builder.full.yml`.
- **Windows installer (CI / publishing):** Pushing a git tag matching **`v*`** (e.g. `v1.0.10`) runs **`.github/workflows/release-windows.yml`**, which runs **`npm ci`** then **`npm run package:nopublish`** on `windows-latest`. The default release artifact is now the light installer; Settings installs/checks Whisper and Gemini after first launch. **`softprops/action-gh-release`** uploads **`release/Snipalot-*-setup.exe`**. Bump **`package.json` `version`** before tagging so the artifact name matches the release.
- **Linux:** `npm run package` on Linux produces AppImage/Snap only, not the Windows setup exe.
- **End-user install:** **[GitHub Releases](https://github.com/Koprowski/snipalot/releases)** — download the latest **`Snipalot-*-setup.exe`**. Full Trade + Gemini guide: **`docs/installation-guide-issue-2.md`** (mirror for **[Issue #2](https://github.com/Koprowski/snipalot/issues/2)** — paste that file into the issue when the download URL changes; API tokens may not edit issues).
- **Config:** `%USERPROFILE%\.snipalot\config.json`; defaults in `src/main/config.ts`.

## Recent improvements (v1.0.1 onward; current release v1.0.25)

- **Fullscreen + screen share:** Before `getDisplayMedia`, main **lowers overlay alwaysOnTop** so Windows’ “what to share” dialog is not hidden behind the Snipalot overlay; then restores `screen-saver` level.
- **Recorder logs in snipalot.log:** Recorder renderer lines are forwarded to main **`log('recorder', …)`** so `%APPDATA%\\Snipalot\\logs\\snipalot.log` shows `getDisplayMedia` progress without `--debug`.
- **Packaged tray + Whisper paths:** Tray icons and Whisper lookup prefer **`process.resourcesPath/resources`** (not `cwd` under Program Files).
- **Processing / trade stalls:** If `save-webm` never arrives or Whisper hangs, a **processing watchdog** returns the launcher to idle with a toast (and Whisper is killed after 25 min). Trade-mode **MockApe wait** defaults to **3 minutes** then proceeds without trade data (was 30 min).
- **`mic_diagnostics.json`** in each **record/trade** session folder when recording starts: `getUserMedia` success/failure, active audio track label + `deviceId` (when exposed), `enumerateDevices` snapshot for `audioinput`. Main logs a one-line **`recorder` / `mic capture summary`**. Use for “no audio” / wrong-default-mic support (Snipalot still uses OS default input; no in-app mic picker yet).
- **Frame picker:** Export uses `recording.mp4` inside the session directory (not the parent folder).
- **Hotkeys:** README, launcher hints, and logs aligned with `config.ts` (e.g. trade marker `Ctrl+Shift+X`, trade toggle `Ctrl+Shift+T`).
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
- **Trade workbook output (local branch):** Trade sessions now generate **`trade_log.xlsx`** with concrete timeline columns (`trade_date`, `entry_time_inferred`, `exit_time_actual`, `time_in_trade_seconds`, etc.), wrapped text columns, width capped at 40 chars, rounded SOL/P&L/market-cap formatting, and no CSV generation. The companion **`trade_log.md`** stays in the session root, uses the same date/time labels, embeds the session GIF at top, and embeds per-trade screenshots.
- **Trade session folder cleanup (local branch):** Trade session roots are kept to polished outputs: GIF, `prompt.txt`, `transcript.txt`, `trade_log.xlsx`, `trade_log.md`, plus the `Inputs/` folder. Raw/support files move under **`Inputs/`** (`mockape.json`, `extraction_response.json`, `markers.json`, `annotations.json`, `NEXT_STEPS.md`, `adherence_report.md`). Trade marker captures live under **`Inputs/trade-screenshots/`**.
- **Trade XLSX dependency (local branch):** Added **`jszip`** as a runtime dependency to emit XLSX files directly from the Electron main process without requiring Excel automation.
- **Trade marker shortcut update (local branch):** Default marker hotkey is **`Ctrl+Shift+X`** ("X marks the spot"). Updated config defaults, Settings reset defaults, HUD/launcher fallback labels, README, and install guide references.
- **v1.0.8 local installer build:** Fresh NSIS build succeeded at **`release-v1.0.8-trade-workbook-xhotkey/Snipalot-1.0.8-setup.exe`** after switching away from a locked prior output directory. SHA256: `33D9483B872BF7BE5616E3781786DF75C854992534814D03250E764556DF53C4`.
- **First-run dependency setup (v1.0.9 local branch):** Settings now has a Trade Mode **Setup checklist** that verifies bundled Whisper, Node/npm, and Gemini CLI. If npm is available but Gemini CLI is missing, users can install `@google/gemini-cli` from Settings, then use **Sign in with Google**. The sign-in button now preflights Gemini CLI and points users back to setup/API mode instead of failing with a raw missing-command error.
- **v1.0.9 local installer build:** NSIS build succeeded at **`release-v1.0.9-dependency-setup/Snipalot-1.0.9-setup.exe`**, then installed locally and registry shows **Snipalot 1.0.9**. Packaged Whisper verified under installed `resources/resources/bin/whisper/whisper-cli.exe`; model verified under `resources/resources/models/ggml-base.en.bin`. SHA256: `D629042DDD4BCE07763D0DF3739CC7641E2D7C21E1E05296AD479A3C80016891`.
- **Processing escape hatch + window show-race hardening (local branch):**
  - Launcher now exposes **Abandon** during post-stop `processing`. It cancels the in-flight pipeline/trade pipeline, closes any trade-context / response-paste windows, deletes the current session folder, and resets Snipalot to idle.
  - The latest parent-level `recording.mp4` is intentionally preserved when abandoning; session-folder artifacts are cleared.
  - Main now passes an abort signal through ffmpeg / whisper / Gemini / API extraction waits so abandoned sessions do not continue recreating outputs in the background.
  - Recorder HUD visibility is more reliable: if the HUD window has already finished loading before the show hook is attached, main now shows it immediately instead of waiting forever on a missed `ready-to-show`.
  - Trade-context and response-paste windows got the same show-race hardening so they do not stay invisible when the renderer loads unusually quickly.
- **Trade helper windows normalized (local branch):**
  - The post-trade **Add trade data** window and **Paste LLM Response** window were previously forced to `alwaysOnTop` / `screen-saver` z-order, and trade-context also had a keep-bringing-to-front timer. This made them behave unlike normal Windows app windows.
  - They now behave like ordinary windows again: clicking another app puts them behind it, minimizing/restoring works normally, and clicking them again brings them back to front through standard focus behavior.
  - Response-paste also uses a normal framed window again instead of a frameless always-on-top helper surface.
- **Window topmost policy clarified (local branch):**
  - The main launcher window (Record / Screenshot / Trade) should always behave like a normal desktop window. The old launcher pin/topmost behavior is disabled and hidden, and startup forces launcher `alwaysOnTop=false` even if an older config has `launcher.pinnedOnTop=true`.
  - The recording HUD remains intentionally topmost at `screen-saver` level while recording, with the existing keep-on-top interval, because it is the user's stop/pause/snapshot/annotation control surface.
- **HUD shortcut tooltip + one-shot annotations (local branch):**
  - The HUD snapshot camera tooltip now uses the configured `snapshot` hotkey from main state (default `Ctrl+Shift+P`) instead of a hardcoded description, and pause/annotate tooltips also track configured hotkeys.
  - Completed annotations are now one-shot: after a valid shape/line/text annotation is committed, the overlay exits annotation mode and becomes click-through while leaving the annotation visible until clear/snapshot behavior removes it.
- **Trade HUD marker control (local branch):**
  - During trade-mode recordings, the HUD camera button changes to a target-style marker control bound to the configured `tradeMarker` hotkey (default `Ctrl+Shift+X`) instead of the normal `snapshot` hotkey.
  - Trade markers now record offset/label metadata and capture a marker screenshot under `Inputs/trade-screenshots/` without triggering the normal snapshot chapter/annotation reset.
  - The trade extraction prompt now treats markers as entry/decision anchors and MockApe/Padre timestamps as outcome anchors, with explicit instructions to inspect the interval between them for partial entries/exits.
- **Trade workbook display formatting (local branch):**
  - `trade_log.xlsx` wraps `rationale`, `pre_transcript_excerpt`, and `post_transcript_excerpt`, caps auto-fit column widths at 40 characters, and avoids CSV output.
  - XLSX SOL fields (`sol_invested`, `sol_received`, `pnl_sol`) are exported to two decimals, `pnl_percentage` to one decimal, and exit market-cap fields are rounded to whole dollars with comma formatting.
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
 - Completed in v1.0.9 local branch: trade hotkeys are editable in Settings, launcher-X docs/tooltips match full-exit behavior, config write errors propagate to Settings, and `docs/installation-guide-issue-2.md` now documents Gemini CLI/OpenRouter mode instead of the removed Gemini API key field.
- **Settings/docs/persistence hardening (v1.0.9 local branch):**
 - Settings hotkey editor now includes `startTrade` and `tradeMarker`, so all README/config advertised trade shortcuts are rebindable from the UI.
 - Launcher X copy and README/install-guide upgrade text now match current behavior: launcher X exits Snipalot; minimize keeps the launcher/taskbar path.
 - `saveConfig()` is now transactional: it writes the merged config to disk before replacing in-memory config, throws on filesystem errors, and Settings keeps the window open with an error instead of reporting a false successful save.
 - Added `npm test` with `tests/config-persistence.test.mjs` covering successful config writes and disk-write failure behavior.
- **Trade extraction UX + scale-out prompt hardening (v1.0.9 local branch):**
 - `src/main/pipeline.ts` now `await`s `runTradePipeline()` for trade sessions, so launcher processing state and step text stay active through Gemini/API auto-extraction instead of dropping to idle before `trade_log.xlsx` exists.
 - Trade processing ETA in `src/main/index.ts` now budgets a real LLM extraction window for trade mode (instead of a 5-second placeholder), so the progress bar no longer races to the end before Gemini finishes.
 - Gemini CLI default/recommended model is `gemini-3.1-pro-preview`. Current official Gemini 3 docs list Gemini 3.1 Pro with model id `gemini-3.1-pro-preview` and state all Gemini 3 models are currently preview; Settings includes current Gemini 3.1/3 preview ids in the curated model list and warns users to test CLI/account access before saving.
 - Trade extraction schema/prompt now includes `leg_index`, `leg_count`, and `position_fraction`, with explicit instructions to split scaled entries/exits into multiple rows when the transcript indicates partial fills/trims.
 - `joinMockApeById()` now apportions aggregate MockApe size/P&L across multiple rows sharing the same `mockape_trade_id` using `position_fraction` when provided, or equal shares as fallback.
- **Recording start hardening (local branch):**
 - Main now logs the active capture config whenever Record/Screenshot/Trade selection begins, which helps support verify whether fullscreen vs region mode was actually loaded from `%USERPROFILE%\.snipalot\config.json`.
 - `targetOverlay()` now reports whether a targeted overlay send succeeded and queues sends while an overlay is still loading; fullscreen capture falls back to region selection with a notification if the cursor-display overlay cannot be reached.
 - Record/trade startup now catches `desktopCapturer.getSources()` errors and missing display-source matches after confirmation, exits selection mode, and returns to idle instead of leaving the fullscreen transparent overlay stuck in boundary-selection mode.
- **Light installer rollout (v1.0.10 local branch):**
 - Default `npm run package`, `package:nopublish`, CI release workflow, and portable builds no longer run `fetch-resources` or require bundled Whisper; `electron-builder.yml` excludes `resources/bin/whisper/**` and `resources/models/**`.
 - `npm run package:full` / `package:full:nopublish` remain available for later large bundled-Whisper builds via `electron-builder.full.yml`.
 - Settings now exposes **Install Whisper**, which downloads whisper.cpp + `ggml-base.en.bin` into `%APPDATA%\Snipalot\resources`; pipeline and dependency checks search that user-data path before packaged resources.
- **Support-log launcher button (local branch):**
 - Launcher header includes a bug icon that invokes `launcher:copy-support-log`.
 - Main writes a sanitized temp copy of `snipalot.log` to `%TEMP%\snipalot-support\snipalot-support.log`, redacting common API-key/Bearer-token shapes, then uses PowerShell `Set-Clipboard -LiteralPath` so users can paste/upload the log file. If file-copy fails, it falls back to sanitized text on the clipboard.
- **Installer launch/upgrade responsiveness (local branch):**
 - `resources/installer.nsh` no longer performs long silent sleeps while closing an already-running Snipalot during upgrades. Worst-case wait before prompting is now ~5 seconds instead of ~50+ seconds, and the prompt text matches current launcher X behavior. Unsigned EXE Defender/SmartScreen scanning can still cause pre-NSIS launch delay.
- **Trade marker hotkey migration (local branch):**
 - `src/main/config.ts` migrates existing configs that still have the old default `hotkeys.tradeMarker = Ctrl+Shift+M` to the current default `Ctrl+Shift+X` on load. Other custom marker bindings are preserved. Covered by `tests/config-persistence.test.mjs`.
- **Screenshot selection cleanup (local branch):**
 - Screenshot capture now forces countdown `0` regardless of the Record/Trade countdown setting; there should never be a 3-2-1 countdown for screenshots.
 - Overlay confirm no longer pre-promotes a selected region into `recordingRegion`/dashed outline. Recording ownership is set only after main sends `overlay:owns-recording`; screenshot exits selection with no lingering dotted outline.
 - Config loading strips a UTF-8 BOM before `JSON.parse`, preventing PowerShell-written config files from resetting Snipalot to defaults. Covered by `tests/config-persistence.test.mjs`.
- **First-run setup hardening (v1.0.15 local branch):**
 - Settings first-run onboarding now opens a dependency modal with Whisper, Node.js LTS, and Gemini CLI preselected when missing.
 - Node/npm detection no longer relies only on the already-running Electron process PATH; it probes standard Windows Node install folders and runs `npm.cmd` through `cmd.exe` to avoid `spawn EINVAL`.
 - Whisper setup recognizes current whisper.cpp zip layout where `whisper-cli.exe` extracts under `bin/whisper/Release/`, so successful downloads verify correctly.
 - Packaged ffmpeg now resolves `app.asar.unpacked` and `electron-builder` explicitly unpacks `node_modules/ffmpeg-static`, fixing packaged transcription/video export failures caused by trying to spawn ffmpeg inside `app.asar`.
 - Settings install buttons keep real failure messages visible instead of immediately overwriting them with a generic dependency recheck.
 - Existing configs using the old default Gemini CLI model `gemini-2.5-flash` migrate to `gemini-3.1-pro-preview`; custom model choices remain user-controlled.
- **Launcher capture-mode control (v1.0.16 local branch):**
 - Capture mode moved from Settings to a visible launcher segmented control: **Select**, **Full screen**, and disabled **Window**.
 - Record, Trade, and Screenshot now all use the launcher-selected mode, while Settings only keeps the recording countdown.
 - Fullscreen Screenshot bypasses overlay region-select entirely and captures the cursor display directly into Annotator; Select Screenshot still uses the overlay only as a picker with zero countdown.
 - Fullscreen Screenshot hides the launcher before grabbing the frame and uses a request id so cancel/state changes cannot still open Annotator with a stale capture.
- **Installer Finish launch behavior (v1.0.20 local branch):**
 - NSIS `runAfterFinish` is enabled for both light and full installers so Snipalot launches automatically when setup finishes, while still registering the Start Menu shortcut.
- **Launcher capture-mode polish (local branch):**
 - Capture-mode helper/status text now sits directly under the Select / Full screen / Window control.
 - The capture-mode control is styled as a three-state sliding toggle; Window remains visible but disabled/unselectable until implemented.
- **Annotator note-entry focus (local branch):**
 - New screenshot-annotator shapes queue focus to their matching sidebar note textarea after mouse-up so users can start typing immediately; text annotations focus their display-text input.
- **Trade processing visibility + packaged media fix (v1.0.18 local branch):**
 - Launcher is forced visible/topmost while post-recording processing is active, then returns to normal window behavior on completion.
 - Session folders no longer auto-open at trade prompt/response-paste time; Explorer opens only after the full pipeline finishes and outputs are ready.
 - Pipeline warnings/failures now show an explicit modal before opening the folder, so missing transcript/GIF/workbook symptoms are not only discoverable by noticing absent files.
 - HUD is shown immediately once a record/trade region is accepted instead of waiting for the recorder's MediaRecorder `started` callback.
 - Packaged ffmpeg lookup now checks `app.asar.unpacked` explicitly and logs all candidates when missing; this fixes missing transcript/commentary caused by trying to spawn ffmpeg inside `app.asar`.
 - Settings dependency checks log npm probe diagnostics, and Settings no longer logs raw config/API keys.
- **Installer shortcut explicitness (local branch):**
 - NSIS config now explicitly sets `createStartMenuShortcut: true` and `shortcutName: Snipalot` for both light and full installers so Start Menu shortcut creation no longer relies only on electron-builder defaults.
- **Windows npm dependency probe fix (v1.0.19 local branch):**
 - Settings dependency checks now launch `npm.cmd` through `cmd.exe /d /c call ...` with cmd-safe quoting. This fixes false "Node/npm missing" results when Node is installed under `C:\Program Files\nodejs` and npm itself works from a normal terminal.
- **Start Menu shortcut repair (v1.0.21 local branch):**
 - `resources/installer.nsh` now explicitly recreates `$SMPROGRAMS\Snipalot.lnk` on every install/update and sends a shell change notification, avoiding electron-builder's shortcut-preservation path leaving Start Menu search empty after a prior bad/missing shortcut state.
- **Dependency checklist Node/npm loop fix (v1.0.22 local branch):**
 - Added `docs/dependency-check-issue-log.md` to track the recurring Node/npm checklist issue.
 - Settings dependency logs now include `appVersion` so support logs reveal stale installed builds.
 - If Gemini CLI is already installed and runnable, Node/npm is treated as OK/optional instead of a blocking missing dependency; Node/npm is only required for Snipalot-managed Gemini CLI install/update.
- **Packaged ffmpeg + processing visibility fix (v1.0.23 local branch):**
 - `src/main/pipeline.ts` now prefers `app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe` before the virtual `app.asar` path, fixing installed-build ENOENT failures that skipped audio extraction, Whisper transcription, MP4, and GIF.
 - Verified installed ffmpeg + installed Whisper manually against `E:\Video Screencasts\recording.mp4`; ffmpeg extracted WAV and Whisper produced an SRT transcript successfully.
 - Processing launcher z-order is reasserted while processing and after trade-data submit/skip, so the status window should return on top after helper windows close.
 - Trade processing status strings were changed to ASCII for the visible pipeline steps to avoid mojibake such as `adherence reportÃ¢...`.
- **Trade processing polish + plan fields (v1.0.24 local branch):**
 - Processing launcher height increased so the progress bar/ETA is visible again, and processing topmost uses `screen-saver` level without repeatedly calling `moveTop()` on every tick (reduces blinking while keeping the window above other apps).
 - Fullscreen capture copy changed to "Captures Full Screen Based Upon Cursor Location".
 - GIF timecode generation now quotes/escapes the Windows `drawtext=textfile` path; verified a short ffmpeg GIF smoke test against `E:\Video Screencasts\recording.mp4`.
 - Whisper transcript post-processing now drops repeated adjacent hallucination segments and compacts repeated phrases before writing `transcript.txt` / feeding trade extraction.
 - Trade extraction schema/export now includes `stop_loss_mc`, and `trade_log.xlsx` includes `target_exit_low_mc`, `target_exit_high_mc`, and `stop_loss_mc`; Markdown trade logs print a Plan line with targets/stops.
- **Snapshot hotkey + trade output cleanup (v1.0.25 local branch):**
 - `Ctrl+Shift+P` / configured snapshot hotkey is now registered globally: idle state starts the normal Screenshot flow using the current capture mode/cursor display, recording state still closes a snapshot chapter through the HUD snapshot path.
 - Trade workbook/Markdown/adherence outputs now omit Gemini-extracted spoken-only musings when MockApe/Padre data is present; only rows matched to an actual trade are user-facing. Raw `Inputs/extraction_response.json` still preserves the full model response for debugging.
 - Added `docs/exit-screenshot-feature-plan.md` with a feasible design for extracting automatic exit-time screenshots from `recording.mp4` using `mockape_timestamp_ms - recordingStartedAtMs`.

## Packaged app logs

Main logger writes **`snipalot.log`** under Electron’s **`logs`** path (e.g. Windows: `%APPDATA%\Snipalot\logs\snipalot.log`). **Dev** builds still use **`./spike-output/snipalot.log`** next to the repo cwd. If unsure, search the PC for **`snipalot.log`**.

## Open items — intentional deferrals

These came from code review; **not** implemented yet. Pick up as separate tasks if desired.

1. **Unexpected recorder stop** (`recorder:state` → `stopped` while `appState === 'recording'`): Main snapshots `pendingProcessing` and goes to `idle` but does not mirror full `stopRecording()` (processing UI, trade-context window, etc.). Decide product behavior before changing.

2. **IPC payload limits:** Optional caps / validation on renderer-supplied payloads.

3. **Split `src/main/index.ts`:** Large file; splitting by concern would help maintainability.

4. **Dependency / security audit:** `npm audit` upstream noise; dedicated pass if required.

5. **Automated tests:** `npm test` currently covers config persistence. Good next candidates: pipeline helpers, packaged resource lookup, Gemini CLI fallback behavior.

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
| Dependency checklist issue log | `docs/dependency-check-issue-log.md` |
