# Snipalot — agent handoff notes

Use this file to onboard LLMs or humans picking up work without full chat context.

## Planning System: Mission Control vs GitHub

`MC` means Mission Control.

Canonical Mission Control repo:

- GitHub: `Koprowski/mission-control`
- Local Windows path: `E:\Apps\mission-control`

## Canonical Checkout and Sandbox Rule

When a task references another known repo or operating surface, use its
canonical local checkout first.

For Mission Control, the canonical local checkout is:

`E:\Apps\mission-control`

If Codex or another agent is sandboxed and cannot access the canonical checkout,
request filesystem escalation or user approval for that canonical path before
using a fallback. Do not clone the repo into `C:\tmp`, the current repo, or
another temporary path merely because sandboxing blocked access.

Only use a fallback clone/workspace when:

- the canonical checkout is missing;
- the canonical checkout is broken;
- the canonical checkout cannot be accessed after escalation/user approval;
- or the user explicitly asks to use a temporary clone.

If a fallback is used, say so clearly, explain why, and reconcile the canonical
checkout as soon as possible.

For cross-repo work:

1. Identify the canonical repo and local path.
2. Check the canonical checkout first.
3. If blocked by sandboxing, request escalation for the canonical path.
4. Preserve unrelated local changes.
5. Make the requested update in the canonical checkout whenever possible.
6. Commit and push from the canonical checkout when the repo's workflow calls
   for it.
7. Avoid creating duplicate repos, duplicate planning files, or parallel sources
   of truth.

Mission Control/WBS is the master portfolio map across projects. It includes
active work, shaped backlog, discovery items, and high-leverage opportunities
that should compete for attention.

GitHub Issues are the canonical source of truth for repo-specific implementation
detail: PRDs, epics, bugs, reviews, acceptance criteria, and engineering
follow-ups.

When a new repo-tied idea appears:

- If it may affect prioritization, add or recommend a Mission Control/WBS item.
- If it needs product or engineering definition, create or recommend a GitHub
  issue.
- If both are true, do both: create the GitHub issue for detail and add a
  Mission Control/WBS line that links to it.
- Do not treat "not fully shaped" as a reason to omit it from Mission Control.
  Instead mark it as `Discovery/Shaping`.
- Do not treat Mission Control as the place for detailed specs. Keep detailed
  specs in the linked repo artifact.

Planning states:

- `Opportunity`: worth tracking, not yet shaped.
- `Discovery/Shaping`: likely valuable, needs scope and acceptance criteria.
- `Ready`: scoped enough to implement.
- `Active`: currently being worked.
- `Done/Parked`: completed or intentionally deferred.

Command shortcuts:

- `Capture this to MC` / `Capture to MC`: update the appropriate Mission
  Control surface, and capture to OpenBrain when the item should be searchable
  later.
- `MC what changed?`: summarize the latest Mission Control digest and relevant
  repo activity.
- `MC what next?`: recommend the next useful action from Mission Control current
  state, WBS, and recent activity.
- `MC session audit`: summarize this session into Mission Control and OpenBrain.

Decision shortcut:

1. Ask whether the item is repo-tied, cross-project, or personal/process.
2. For repo-tied work, prefer GitHub Issues for implementation detail.
3. For anything that should compete for attention or resources, also put it in
   Mission Control.
4. If uncertain, capture it in Mission Control as `Discovery/Shaping` rather
   than letting it disappear.

Agent behavior:

- When updating Mission Control from another repo, preserve unrelated local work
  in both repos.
- After any significant code change or fix in this repo, update `AGENTS.md`
  with the outcome, verification, and any follow-up issues so future agents do
  not have to reconstruct the context from chat history.
- If filesystem permissions block direct edits to `E:\Apps\mission-control`,
  request escalation/user approval for the canonical checkout rather than
  writing Mission Control content into the current repo or a fallback clone.
- After meaningful Mission Control changes, commit and push the Mission Control
  repo unless the user asks not to.

## Repo snapshot

- **Stack:** Electron 41, TypeScript (strict), main process in `src/main/index.ts`, renderers under `src/*`, post-processing in `src/main/pipeline.ts` and `src/main/trade-pipeline.ts`.
- **Build:** `npm ci` then `npm run build`. Run app: `npm run dev`.
- **Windows installer (local):** On a Windows machine, `npm run package` produces the default **light installer** at **`release/Snipalot-<version>-setup.exe`** (see `electron-builder.yml`). `package:portable` builds the portable exe. Use `npm run package:full` only when intentionally building a large bundled-Whisper installer from `electron-builder.full.yml`.
- **Windows installer (CI / publishing):** Pushing a git tag matching **`v*`** (e.g. `v1.0.10`) runs **`.github/workflows/release-windows.yml`**, which runs **`npm ci`** then **`npm run package:nopublish`** on `windows-latest`. The default release artifact is now the light installer; Settings installs/checks Whisper and Gemini after first launch. **`softprops/action-gh-release`** uploads **`release/Snipalot-*-setup.exe`**. Bump **`package.json` `version`** before tagging so the artifact name matches the release.
- **Linux:** `npm run package` on Linux produces AppImage/Snap only, not the Windows setup exe.
- **End-user install:** **[GitHub Releases](https://github.com/Koprowski/snipalot/releases)** — download the latest **`Snipalot-*-setup.exe`**. Full Trade + Gemini guide: **`docs/installation-guide-issue-2.md`** (mirror for **[Issue #2](https://github.com/Koprowski/snipalot/issues/2)** — paste that file into the issue when the download URL changes; API tokens may not edit issues).
- **Config:** `%USERPROFILE%\.snipalot\config.json`; defaults in `src/main/config.ts`.

## Recent improvements (v1.0.1 onward; current release v1.0.36)

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
- **Session-local processing diagnostics (local branch):** Trade/recording sessions now write a compact sanitized **`Inputs/processing_log.jsonl`** trail as soon as the live session folder exists. It records session start, mic diagnostics, `save-webm`, Whisper, MP4/GIF, prompt, trade-data, LLM extraction, manual response, MockApe join, output generation, warnings/timeouts, and failures without including prompt/transcript bodies or API keys. This is meant to diagnose archive folders where global `%APPDATA%\\Snipalot\\logs\\snipalot.log` is unavailable.
- **2026-05-05 archive triage:** In `E:\OneDrive\Snipalot Captures\Archive`, four trade folders were reviewed. `20260505.1735 trade` had transcript/GIF/prompt/MockApe/markers but no `Inputs/extraction_response.json`, so it stopped at manual/LLM-response fallback. `20260505.2006 trade` and `20260505.2225 trade` only had `mic_diagnostics.json` (and one empty `Inputs/trade-screenshots` folder), indicating the session got far enough for mic capture but not far enough for saved media/pipeline outputs. `20260505.2234 trade` was the only complete session with `trade_log.xlsx`, `trade_log.md`, `extraction_response.json`, and `adherence_report.md`.
- **GIF readability improvement (local branch):** GIF previews now downscale to max **1600px wide** with Lanczos scaling instead of a hard 800px width. Tests against `E:\OneDrive\Snipalot Captures\recording.mp4` showed 1280px improved but still borderline for ultrawide chart/table text; 1600px was a better default balance. Expect larger GIFs than prior releases, especially on long recordings.
- **Gemini long-prompt fix (local branch):** May 5 `20260505.1735 trade` failed auto-extraction because the 33k-character prompt was passed directly through `--prompt`, causing Windows `spawn ENAMETOOLONG`. Gemini auto-extraction now passes only a short instruction in argv and streams the full prompt through stdin, matching Gemini CLI help text that `--prompt` is appended to stdin. This should let long transcripts / large MockApe payloads run without falling to manual paste.
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
- **Invalid hotkey startup trap fix (v1.0.26 local branch):**
 - Son's support log showed `tradeMarkerHotkey="Ctrl+Shift+ "`; clicking Trade still failed because entering recording mode registers the trade-marker hotkey and Electron threw `conversion failure from Control+Shift+ ` before recorder start.
 - Config load now sanitizes malformed hotkeys back to defaults (covered by `tests/config-persistence.test.mjs`), Settings normalizes literal Space as `Space` instead of a blank, and Settings save validates each combo has a modifier plus a real key.
 - Global hotkey registration now catches thrown Electron accelerator errors, and recording startup unwinds to idle/clears overlay interaction if a startup exception occurs after region confirmation but before recorder start.
- **Installer Finish responsiveness (v1.0.27 local branch):**
 - Startup now creates/shows the visible launcher before building hidden full-screen overlay windows and the hidden recorder, then initializes capture surfaces on a short deferred tick.
 - Capture actions still initialize overlays/recorder on demand if the user clicks Record/Screenshot/Trade before deferred startup finishes.
 - This targets the Windows "Not Responding" dialog seen after pressing NSIS Finish with `runAfterFinish` enabled, where auto-launched Snipalot could look hung while hidden capture windows were being created before any visible app window painted.
- **Windows app icon + Smart App Control note (v1.0.28 local branch):**
 - `scripts/make-icon.mjs` now emits a multi-size `resources/icons/app.ico` from the existing red record-dot artwork; light/full electron-builder configs use the `.ico` for the Windows executable/taskbar/Start Menu icon instead of relying on PNG fallback behavior.
 - Main-process windows resolve icons through a packaged-aware helper (`process.resourcesPath/resources` when installed, repo `resources/` in dev), preventing installed windows from falling back to generic Electron icon assets.
 - README/install guide now call out that Windows Smart App Control has no per-app bypass for unsigned/untrusted builds; users must turn it off on that PC or use a future signed installer.
- **Launcher button visibility controls (local branch):**
 - Added `launcher.visibleActions` config for the main launcher buttons. Defaults are Record + Screenshot visible and Trade hidden for the general-user workflow.
 - Settings now has a **Launcher Buttons** section where users can show/hide Record, Screenshot, and Trade; at least one button must remain visible.
 - Launcher state includes `visibleActions`, and the renderer collapses the button/shortcut layout to one, two, or three visible actions. Hidden buttons can still reappear while their mode is active so cancel/processing controls remain reachable.
 - Global shortcut registration now follows `launcher.visibleActions` for idle start actions: hidden Record disables `startStop`, hidden Screenshot disables idle screenshot, and hidden Trade disables idle `startTrade`. Recording/HUD controls remain available while their HUD action is visible.
 - Local NSIS build succeeded at **`release-v1.0.29-launcher-actions/Snipalot-1.0.29-setup.exe`** after the default `release/win-unpacked` output was locked by Windows. SHA256: `C358C230DDF727A1E65B64360E39BCBC6D35670306916B61A508DADAA75D706A`.
- **Launcher hidden-button CSS fix (v1.0.30 local branch):**
 - Fixed launcher CSS so elements with the `hidden` attribute use `display:none !important`; button classes such as `.btn-trade { display:flex }` were overriding native hidden rendering, causing Trade to remain visible even when `launcher.visibleActions.trade=false`.
 - Local NSIS build succeeded at **`release-v1.0.30-hidden-buttons/Snipalot-1.0.30-setup.exe`**. SHA256: `6137B8F3C43CA52DC5380A0056E2149AE5E1212FA7BAE37DE48E80EAC98F8399`.
- **Settings visibility refresh + Windows icon fix (v1.0.31 local branch):**
 - `settings:save` now rebroadcasts launcher state and reapplies launcher visibility immediately after saving, so toggling Record/Screenshot/Trade visibility in Settings updates the already-open launcher without requiring restart/state transition.
 - Browser windows now pass an explicit generated PNG `nativeImage`, and the installer-created Start Menu shortcut points directly at bundled `resources/resources/icons/app.ico`; this avoids relying on EXE resource editing, which requires `winCodeSign` extraction/symlink privileges on local Windows builds.
 - Installer Finish `Run Snipalot` lockups are likely caused by NSIS launching the unsigned Electron app through `StdUtils.ExecShellAsUser` while Windows/Defender scans/initializes it. Solution options: uncheck Run Snipalot, disable `runAfterFinish`, or replace the finish-page launch with a custom detached helper path.
 - Local NSIS build succeeded at **`release-v1.0.31-settings-icon-2/Snipalot-1.0.31-setup.exe`** after the first v1.0.31 output directory was locked by Windows. SHA256: `BBA6BDAC5121E2083A126B91EF9C03CA047570C634E75F47AF6D6CFBF62195C9`.
- **Record-first launcher default + per-machine installer (v1.0.32 local branch):**
 - Added a targeted config migration for the accidental transitional state `{ record:false, screenshot:true, trade:true }`, resetting it to the general default `{ record:true, screenshot:true, trade:false }`; intentional trade-only configs remain possible.
 - Windows BrowserWindow icon loading now prefers the generated `.ico`, and electron-builder executable resource editing is re-enabled so CI can embed the icon in `Snipalot.exe` for taskbar identity.
 - NSIS installer now defaults to `perMachine: true` so installs are for all users by default and prompt for admin elevation.
 - Local `electron-builder` packaging is currently blocked on this PC when EXE resource editing is enabled: `winCodeSign-2.6.0.7z` extraction fails because 7-Zip cannot create symlinks without the required Windows privilege. Use GitHub Actions/CI for the v1.0.32 installer, or enable Developer Mode/run elevated if local packaging must embed EXE icon resources.
- **Processing launcher action collapse (v1.0.33 local branch):**
 - During `processing`, the launcher now hides normal Record/Screenshot/Trade action buttons and shortcut chips, showing only the processing/Abandon control plus progress/status. Abandon remains available even if Record is hidden, because it is a processing escape hatch rather than a launcher Record action.
- **Semi-automatic updater (v1.0.34 local branch):**
 - Settings **Check / Install Update** now uses the latest GitHub release API to find the `Snipalot-*-setup.exe` asset. When an update is available, the user can confirm once, Snipalot downloads the installer to `%TEMP%\snipalot-updates`, launches it through a detached Windows handoff command, and exits itself so the installer can replace the running app. If no installer asset is found, Settings falls back to opening the release page.
- **Footer update action (v1.0.35 local branch):**
 - Removed the bulky About-section update button. The Settings footer version label now owns update UX: it is quiet/disabled when up to date, retryable if update checks fail, and becomes a clickable install action when a newer `Snipalot-*-setup.exe` is available.
- **Updater installer launch fix (v1.0.36 local branch):**
 - The v1.0.34 updater successfully downloaded `Snipalot-1.0.35-setup.exe` to `%TEMP%\snipalot-updates`, but its `cmd.exe /c timeout ... & start ...` handoff could get stuck and never surface the installer. The updater now spawns the downloaded installer EXE directly, waits for the process `spawn` event, logs the installer PID, and only then exits Snipalot.
- **Updater elevation handoff fix (local branch):**
 - v1.0.36 direct `spawn(installerPath)` could fail with `EACCES` when launching the per-machine NSIS installer from Settings because Windows needs ShellExecute/elevation semantics, not raw CreateProcess. The updater now starts `powershell.exe` and uses `Start-Process -LiteralPath` for the downloaded installer, then exits Snipalot after the handoff starts.
- **Updater SmartScreen handoff polish (local branch):**
 - The updater now tries Electron `shell.openPath(installerPath)` first so Windows owns the launch path and can surface SmartScreen / "More info" / "Run anyway" prompts to the user. If that fails, it falls back to PowerShell `Start-Process`; if a downloaded installer still cannot launch, Snipalot shows the installer in File Explorer and tells the user to run it manually.
 - Settings update confirmation/status copy now explicitly warns that Snipalot cannot click SmartScreen buttons and the user may need to choose **More info -> Run anyway**.
- **Screenshot annotator context-only prompt fix (local branch):**
 - The annotator now treats **Context for Claude** text as prompt source content even when the user does not draw annotations. Context-only screenshot sessions generate/copy/save a real `prompt.md`, and the toolbar save affordance appears when a screenshot plus context exists.
- **Screenshot hotkey / first-capture hardening (local branch):**
 - Overlay broadcasts now route through `targetOverlay()` so region-select / exit IPC is queued until a newly-created overlay finishes loading. This prevents first-capture shortcut presses from dropping the selection command while overlays are still warming up.
 - Screenshot hotkey cancel is debounced for 600 ms after entering `selecting-screenshot`, avoiding immediate toggle-off when Windows/Electron emits a repeat for `Ctrl+Shift+P`.
 - Fullscreen screenshot capture suppresses launcher re-show during the selecting state, reducing visible show/hide blinking before the frame grab.
 - Screenshot and recording display-source lookup no longer silently falls back to `sources[0]` when the requested display id is missing; Snipalot now fails visibly instead of capturing the wrong monitor.
- **Annotator clipboard overlay paste fallback (local branch):**
 - Annotator base-image paste and **Paste Overlay** now use an Electron-native `clipboard.readImage()` IPC fallback when Chromium `navigator.clipboard.read()` does not expose a Windows clipboard image. This fixes cases where another app/chat proves the clipboard has an image, but the annotator reported "No image in clipboard."
 - Document-level paste still ignores text-field pastes, so typing/pasting into context or prompt fields does not trigger image clipboard alerts.
- **Annotator save-location visibility + saved prompt footer (local branch):**
 - Annotator toolbar now shows the active Settings → Output Folder and includes a Settings shortcut so users can see or change where screenshot sessions are saved.
 - `prompt.md` and the copied clipboard prompt now append the generated session folder plus `snapshot.png` path, replacing the old standalone `C:\Tools\annotator-screenshots` assumption with the real Snipalot save location.
- **Annotator image-only prompt + focus hardening (local branch):**
 - Loading a screenshot now generates a useful baseline prompt even before any annotation/context is added, so Save Session can copy/save a prompt that references the captured screenshot and saved paths.
 - Shape/doodle annotation mouse-up focus was hardened against the sidebar auto-sync re-render so the note textarea remains focused immediately after drawing; new annotations still default to `improvement`.
 - Added sanitized `r:annotator:focus` diagnostics for annotation commit, sidebar render, focus queue/attempt/success, and typed-key routing. These logs intentionally avoid note text and key values; use them to confirm why note input focus does or does not stick after drawing.
 - Follow-up log review on 2026-05-16 found dev-mode logs at `spike-output/snipalot.log`, not `%APPDATA%\Snipalot\logs`. The repro showed `sidebar rendered selected annotation` with `textareaFound:true` but no `annotation committed` / `focus queued`, meaning the sidebar existed but the focus queue was not reached. Focus now queues immediately after sidebar render and before prompt regeneration, selection of existing annotations also queues focus, and annotator console/preload/render-process failures are forwarded to the main log.
 - Second follow-up log review found the concrete blocker: `renderLabels()` tried to set `innerHTML` on missing `#labels-layer`, throwing on every annotation render before focus could queue. `renderLabels()` now no-ops when the legacy labels layer is absent; `npm test` passed afterward.
- **Dev/taskbar icon hardening (local branch):**
 - Main now sets the Windows AppUserModelID before single-instance/window setup and passes the generated `.ico` path directly to Windows BrowserWindow options, improving dev-mode taskbar identity instead of inheriting Electron/default artwork.
- **Settings update download progress (local branch):**
 - The Settings footer update/install flow now streams installer downloads instead of buffering with `arrayBuffer()`. Main emits sanitized `settings:update-download-progress` IPC events with downloaded bytes, total bytes, and percent; Settings renders a compact progress bar plus MB/percent text while `downloadAndInstallUpdate()` runs.
- **Chunked Whisper transcription hardening (local branch):**
 - Long recordings no longer run Whisper as one full-file decode. The pipeline now extracts 180-second WAV chunks with 5-second overlap, runs Whisper with `--max-context 0`, merges timestamped segments back into the full recording timeline, and retries audio-present/no-speech chunks with normalized audio.
 - Per-chunk audio diagnostics use ffmpeg `volumedetect`; if audio is present but Whisper still returns only noise labels or no speech, the transcript gets an explicit `[AUDIO PRESENT - ... review]` marker instead of a false silent tail. Session `Inputs/processing_log.jsonl` records chunk volume, retry, suspicious, and segment counts.
- **Session diagnostics + Gemini stdin fix (v1.0.37 local branch):**
 - Each record/trade session now writes a compact sanitized `Inputs/processing_log.jsonl` with session, recorder, pipeline, Whisper, Gemini/API, MockApe, output, abandon, and failure milestones. The file intentionally redacts secret-looking values and omits large prompt/transcript/raw-response bodies so users can share session-local diagnostics without hunting for the global app log.
 - Trade Gemini CLI extraction no longer places the full prompt in command-line argv. It sends the full prompt on stdin with a short `--prompt` instruction, avoiding Windows `spawn ENAMETOOLONG` failures on long sessions such as `20260505.1735 trade` (~33k chars).
 - GIF preview export now uses a 1600px Lanczos-scaled preview instead of 800px, improving readability while keeping the MP4 as the high-quality source of truth.
 - May 5 archive triage: `20260505.1735 trade` failed because Gemini CLI never launched (`spawn ENAMETOOLONG`), `20260505.2006 trade` was discarded, `20260505.2225 trade` had the recorder renderer killed before save, and `20260505.2234 trade` succeeded. Rebuilt MockApe-only review workbooks were created in those failed session folders, plus a consolidated master workbook outside the repo.
- **v1.0.37 local installer build:** NSIS light installer built at **`release/Snipalot-1.0.37-setup.exe`**. SHA256: `A47B7103A562313D5F01B79A2376E178AE14F1806C4D64FDF1A6F849726AFC4E`. Local packaging needed `--config.win.signAndEditExecutable=false` because electron-builder's `winCodeSign` cache extraction tried to create Darwin symlinks and Windows returned "A required privilege is not held by the client"; tests passed before packaging.
- **Log security hardening (local branch):**
 - `src/main/logger.ts` now centrally redacts common API keys, Bearer tokens, password/secret/token fields, Google API keys, OpenRouter/OpenAI-style keys, and PEM private keys before writing any log line.
 - Logger now rotates `snipalot.log` at 5 MB, keeping `snipalot.log.1` through `.3`, so dev and packaged logs do not grow forever.
 - Support-log export redaction now covers legacy `geminiApiKey` in addition to OpenAI/OpenRouter keys.
 - Added `tests/logger-redaction.test.mjs` covering log redaction and rotation. Local dev/package logs were redacted in place on 2026-05-01; active `%USERPROFILE%\.snipalot\config.json` was intentionally not modified because it stores configured keys needed for API mode.
- **SignPath application prep (local branch):**
 - README now includes a `Code Signing Policy` section required by SignPath Foundation, including SignPath attribution, release artifact scope, maintainer/reviewer/approver role, and privacy statement for local processing plus user-configured LLM backends.
- **Trade sync helper-formula repair (2026-05-17):**
 - `E:\OneDrive\Snipalot Captures\Trade Sync Scripts\sync-master-trading-log.mjs` is the live shared importer; repo mirror is `tools/sync-master-trading-log.mjs`.
 - Default sync no longer backfills from `Archive`; use `-BackfillArchive` explicitly if intentionally restoring archived rows. This preserves rows the user deleted from `Master Trading Log`.
 - New rows are sorted by `trade_date` and video/start time before appending, then Excel finalization handles `tblTrades` and `tblAnalysis` range updates.
 - Do not use XML cloning for `Analysis` formulas. Excel COM owns formula fill-down, helper cells, and dynamic spill behavior so formulas do not gain unwanted `@` implicit-intersection prefixes or duplicate spill anchors.
 - Follow-up repair: the Node importer no longer edits `Analysis`; it appends/imports master values and writes `trade_date` as Excel date serials using the workbook's detected date style. `run-trade-sync.ps1` now calls `finalize-master-workbook.ps1`, which uses Excel COM to resize `tblTrades`/`tblAnalysis`, restore the single `Analysis!Q2` dynamic spill formula, fill helper formulas through Excel, recalculate, and save. `-RepairOnly` runs the same Excel finalization without processing or archiving pending trade folders.
 - Daily chart repair: `finalize-master-workbook.ps1` also refreshes the two daily charts from the live helper rows and forces their category axes to text/category axes, not date axes. This prevents Excel from inserting visual gaps for calendar days that do not exist in the helper data.
 - Trade chart repair: the finalizer refreshes trade-level charts every run: `Cumulative P&L (SOL)` uses `Analysis!A:O`, `P&L % per Trade` uses `Analysis!AK:AQ`, `Entry Market Cap vs P&L %` uses `Analysis!AP:AQ`, and `Hold Time vs P&L %` uses `Analysis!AR:AQ`, all through the current master row.
- **NICS/meta-cluster master import (2026-05-18):**
 - `trade_log.xlsx` columns AA:AU now import as trailing `tblTrades` columns after `TimeBucket`: `meta_cluster_id`, `meta_name`, N/I/C/S scores and rationale fields, `NICS_score`, setup flags, count/reset fields, non-NICS and cluster P&L percent fields, and `llm_grade_notes`.
 - The live master `E:\OneDrive\Snipalot Captures\master trading log.xlsx` was updated from `20260518.1456 trade`: `tblTrades` is now `A1:BC338`, rows 331-338 carry cluster IDs `M.260518.1` through `M.260518.5`, and the source session was archived to `Archive\20260518.1456 trade archived 2026-05-18T22-07-59-274Z`.
 - The importer can extend stale/narrow `tblTrades` metadata when the visible master headers are correct; the Excel finalizer now resizes `tblTrades` through `BC` and applies basic number formats for the NICS score/count and percent-point columns.
 - Follow-up automation: Gemini extraction now asks for the judgment fields (`meta_name`, N/I/C/S scores and whys, `NICS_score`, `trade_type`, `llm_grade_notes`) and generated session `trade_log.xlsx` files include AA:AU by default. The sync script remains the historical reconciler: it assigns/reuses stable `meta_cluster_id`, fills deterministic setup/count/cooldown/P&L fields when missing, writes the completed NICS columns back into the session workbook, then imports to master.
 - The importer also reports `rowsBackfilled` and can update existing master rows when the row was already imported but NICS fields were blank, preserving `tblTrades` as `A:BC`.
 - Validation on 2026-05-18: `npm test` passed; a temp sync with AA:AU stripped from `trade_log.xlsx` proved session workbook writeback, and a duplicate-row temp sync proved master NICS backfill (`rowsAdded=0`, `rowsBackfilled=8`).
- **v1.0.44 local installer build:** Built the NICS automation installer at **`release/Snipalot-1.0.44-setup.exe`** with `npm run package:nopublish -- --config.win.signAndEditExecutable=false`. SHA256: `93D83C4AF8C62A22E7549E2C14600DBDE77434A2F51D222312223F6B2D238C6A`. Build killed a stale installed `Snipalot.exe` first, then completed successfully.
- **Screenshot overlay selection fix (v1.0.45 local branch):**
 - Root cause: after monitor/display rebuilds, old overlay BrowserWindows closed asynchronously and deleted the replacement window from `overlayWindows` when the display id was reused. Screenshot selection still entered `selecting-screenshot`, but `broadcastOverlay('overlay:enter-region-select')` had no live overlay map entry, so the user never saw or could draw the selection layer.
 - Fix: overlay `closed` handlers now only remove the map entry if the closing BrowserWindow is still the registered value; stale closes are logged as `stale overlay closed`.
 - Validation/build: `npm test` passed on 2026-05-19. Local installer built at **`release/Snipalot-1.0.45-setup.exe`** with `npm run package:nopublish -- --config.win.signAndEditExecutable=false`. SHA256: `A77DDEA8664AC5C17E24082BC93808DDE6334F39E7AD8B3683A9ADD808E4AD6D`. Build killed a stale installed `Snipalot.exe` first, then completed successfully.
- **Startup update check (v1.0.46 local branch):**
 - The GitHub latest-release scan now starts in the main process at app startup, right after the launcher window is created, instead of waiting for the user to open Settings.
 - Settings `check-for-updates` now reuses a successful cached startup result or joins an in-flight startup request; failed checks are retried on the next request so the footer retry path still works.
 - Validation/build: `npm test` passed on 2026-05-19. Local installer built at **`release/Snipalot-1.0.46-setup.exe`** with `npm run package:nopublish -- --config.win.signAndEditExecutable=false`. SHA256: `46029761D70346F4F32D9B2B961675781848ADC7492BD722D2A6657A1AF59E59`. Build killed a stale installed `Snipalot.exe` first, then completed successfully.
- **NICS scoring standard update (2026-05-19):**
 - `src/main/trade-pipeline.ts` now prompts Gemini/API extraction to score N/I/C/S separately. v1.0.48 changed `NICS_score` to `N_score + I_score + C_score + S_score`; v1.0.51 aligned counting to the explicit component rule: `size_ok=true`, `N_score=1`, `I_score=1`, and at least one of `C_score`/`S_score=1`, with zone/cooldown tracked but not gating.
 - `tools/sync-master-trading-log.mjs` is the enforcement/reconciliation layer for master import. It recomputes `NICS_score`, setup flags, cooldown, count, hard-reset, and non-NICS P&L fields during sync; it no longer allows same-cluster re-entry inside the 5-minute post-loss cooldown.
 - The live shared sync script at `E:\OneDrive\Snipalot Captures\Trade Sync Scripts\sync-master-trading-log.mjs` was updated to match the repo mirror. Validation: `npm test` and `node --check tools\sync-master-trading-log.mjs` passed.
- **Trade sync test-mode loop (2026-05-19):**
 - `tools\run-trade-sync.ps1 -TestMode` now passes `--test-mode` to the Node importer. Test mode leaves pending `* trade` folders in place instead of archiving them and removes/rebuilds matching `source_session` rows before import so repeated sync testing no longer requires manually moving folders out of `Archive` or deleting master rows.
 - `tools\run-trade-sync.ps1 -ArchiveOnly` is the cleanup step after a successful test sync. It moves completed current `* trade` folders with `trade_log.xlsx` or legacy `trade_log.csv` into `Archive` without importing, rewriting, or finalizing `master trading log.xlsx`.
 - Lower-level flags are also available: `-NoArchive` / `--no-archive` preserves source folders, and `-ReplaceSourceRows` / `--replace-source-rows` replaces rows for all source folders processed in that run. Do not use `-BackfillArchive` for the normal test loop; it means "include already archived folders as import inputs" and can disturb manual one-off workbook adjustments.
- **NICS workbook schema repair (v1.0.47 local branch):**
 - Generated session `trade_log.xlsx` now uses the same 55-column shape as `tblTrades`: source fields, workflow fields, Hour/Weekday/WeekdayNum/TimeBucket, then NICS/meta fields. The workbook no longer emits the old 47-column session-only shape.
 - Trade generation now runs a focused NICS backfill pass when the first Gemini/API extraction omits required N/I/C/S classifications. The pass writes `Inputs/nics_response.json`, merges the graded fields before output, and leaves history-dependent fields such as `meta_cluster_id`, cooldown, and running count to sync.
 - Sync now also merges `Inputs/nics_response.json` when present and writes reconciled session workbooks back in the 55-column master-compatible shape.
 - 2026-05-19 repair: `E:\OneDrive\Snipalot Captures\20260519.1529 trade\trade_log.xlsx` was rebuilt to 55 columns and all 9 trades received NICS classifications; matching rows in `E:\OneDrive\Snipalot Captures\master trading log.xlsx` were updated through Excel COM so the workbook remains openable. Both workbooks were verified to open in Excel.
 - The structural reference workbook `E:\OneDrive\Snipalot Captures\Statements\master trading log.xlsx` was restored from backup after an experimental XML rewrite made it unopenable; do not use XML full-rewrite against that template without an Excel-open validation pass.
 - Validation/build: `npm test` and `node --check tools\sync-master-trading-log.mjs` passed on 2026-05-19. Local installer built at **`release/Snipalot-1.0.47-setup.exe`** with `npm run package:nopublish -- --config.win.signAndEditExecutable=false`. SHA256: `E3C0623C13CF60623DE7E29C77E92AF5FDB5EE04087969D381F5B1580317C18C`. Build killed a stale installed `Snipalot.exe` first, then completed successfully.
- **Sync-time NICS evidence generation (v1.0.48 local branch):**
 - `tools\sync-master-trading-log.mjs` now treats sync as the reconciliation authority for missing NICS fields. If session rows are missing `meta_name` or N/I/C/S scores/why fields, sync first merges `Inputs\nics_response.json`; if that cache is missing or incomplete, it regenerates the NICS response from `transcript.txt`, `prompt.txt`, `Inputs\extraction_response.json`, `Inputs\mockape.json`, and `Inputs\markers.json`, then writes the audit cache back to `Inputs\nics_response.json`.
 - The sync script now prefers `E:\OneDrive\Snipalot Captures\Statements\master trading log.xlsx` when present, matching the current 55-column structural reference workbook. `--master` or `SNIPALOT_MASTER_TRADING_LOG` can override this.
 - Master XML rewrites no longer add a worksheet-level `autoFilter` over the Excel table filter; this was the cause of repeat sync outputs that Excel refused to open. Always keep an Excel-open validation pass after changing this writer.
 - Validation on 2026-05-19: fresh temp sync generated `Inputs\nics_response.json` for `20260519.1529 trade` from saved evidence, merged 9 NICS rows, rewrote the session workbook, and imported into a temp copy of the Statements master. Excel COM verified both temp workbooks open (`Master Trading Log` 337x55, `Trade Log` 10x55).
 - Validation/build: `npm test` passed on 2026-05-19. Local installer built at **`release/Snipalot-1.0.48-setup.exe`** with `npm run package:nopublish -- --config.win.signAndEditExecutable=false`. SHA256: `A90D67821A24B1B2F8B191F03BD5C7AE08AAF483EC499DB1DBB62F0D811B772A`. Build killed a stale installed `Snipalot.exe` first, then completed successfully.
- **Trade sync wrapper alignment (2026-05-19):**
 - `run-trade-sync.ps1` and `finalize-master-workbook.ps1` now resolve the same master workbook as the Node importer: explicit `-MasterPath`, `SNIPALOT_MASTER_TRADING_LOG`, then `Statements\master trading log.xlsx`, then root `master trading log.xlsx`.
 - The wrapper forwards `-MasterPath` into both the Node importer (`--master`) and Excel finalizer, and its completion message prints the actual workbook finalized.
 - The finalizer COM cleanup now ignores non-COM values returned by Excel calls, preventing cleanup from failing an otherwise successful finalization. Workbook open is also wrapped in the existing Excel retry loop because OneDrive can briefly hold the `.xlsx` after the Node writer closes it.
 - Validation: temp `-RepairOnly` run against a root containing only `Statements\master trading log.xlsx` completed successfully and finalized the Statements workbook. Excel COM schema audit verified the live Statements `tblTrades` has 55 columns, range `A1:BC9`, and zero header mismatches against `tools\sync-master-trading-log.mjs`.
 - Test execution requested by user: ran live `Trade Sync Scripts\run-trade-sync.ps1 -CapturesRoot E:\OneDrive\Snipalot Captures -MasterPath E:\OneDrive\Snipalot Captures\Statements\master trading log_test.xlsx -NoArchive -ReplaceSourceRows`. The first run imported rows but hit an Excel RPC open race; after adding workbook-open retry, the rerun completed. Result: `master trading log_test.xlsx` opens, `tblTrades` is `A1:BC36`, and sessions imported `20260519.1529 trade` 9 rows, `20260519.1710 trade` 16 rows, `20260519.2002 trade` 2 rows, all with complete NICS judgment fields. `20260519.1954 trade` had no importable trade log and stayed skipped. No current trade folders were archived.
- **Trade sync actuals repair and count rule fix (v1.0.50 local branch):**
 - Root cause for apparent Q:T column shifts was corrupted source values in session `trade_log.xlsx`, especially `20260519.1529 trade`, not a master header mismatch. When target/stop fields were blank, actual exit/size/P&L values had previously been written into the wrong adjacent workflow fields.
 - Sync now repairs workflow values from authoritative session evidence before import: `Inputs\extraction_response.json` restores target/stop/commentary fields and `Inputs\mockape.json` overwrites actual entry/exit market caps plus SOL/P&L fields by `mockape_trade_id`. This also writes the repaired 55-column session workbook back to disk.
 - v1.0.50 temporarily counted via `NICS_score >= 3` plus size; v1.0.51 supersedes that with the explicit component rule below.
 - Validation: reran live `_test` sync with `-NoArchive -ReplaceSourceRows`. `master trading log_test.xlsx` opens as `A1:BC36`; `20260519.1529 trade` actuals now land in `exit_mc_actual`, `sol_invested`, `sol_received`, `pnl_sol`, and `pnl_percentage` correctly, and count summaries were `20260519.1529 trade` 6 true / 9, `20260519.1710 trade` 13 true / 16, `20260519.2002 trade` 1 true / 2. Source folders remained in place. `npm test` passed.
- **Count-to-50 numeric output (v1.0.51 local branch):**
 - `counts_toward_50` is now written as numeric `1`/`0` instead of boolean `TRUE`/`FALSE` so Excel can sum it directly.
 - The count rule is explicit and component-based: `size_ok=true`, `N_score=1`, `I_score=1`, and `C_score + S_score >= 1`. `NICS_score` remains the four-component total, but a raw score threshold alone is not used for counting.
 - `tools\sync-master-trading-log.mjs` treats `counts_toward_50` as an integer column when writing both master and session workbooks. Generated app workbooks also emit `1`/`0` for this column before sync.
 - Validation: reran live `_test` sync with `-NoArchive -ReplaceSourceRows`. Excel COM verified `master trading log_test.xlsx` opens as `A1:BC36`, `counts_toward_50` is column 50, values are numeric `0/1`, and there were zero mismatches against the explicit count rule. Count sums were `20260519.1529 trade` 6, `20260519.1710 trade` 12, and `20260519.2002 trade` 1.

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
