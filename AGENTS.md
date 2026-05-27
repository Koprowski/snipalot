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
- Before pushing substantive Codex-authored repo changes, make sure there is a
  durable trace target: GitHub issue/PR, Mission Control WBS/briefing/logbook,
  repo-local handoff note, OpenBrain capture, or an explicit digest-only note.
  Use `E:\Apps\mission-control\resources\repo-change-traceability.md` for the
  routing decision.
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

## Recent improvements (v1.0.1 onward; current release v1.1.1)

- **Fullscreen + screen share:** Before `getDisplayMedia`, main **lowers overlay alwaysOnTop** so Windows’ “what to share” dialog is not hidden behind the Snipalot overlay; then restores `screen-saver` level.
- **Recorder logs in snipalot.log:** Recorder renderer lines are forwarded to main **`log('recorder', …)`** so `%APPDATA%\\Snipalot\\logs\\snipalot.log` shows `getDisplayMedia` progress without `--debug`.
- **Packaged tray + Whisper paths:** Tray icons and Whisper lookup prefer **`process.resourcesPath/resources`** (not `cwd` under Program Files).
- **Processing / trade stalls:** If `save-webm` never arrives or Whisper hangs, a **processing watchdog** returns the launcher to idle with a toast (and Whisper is killed after 25 min). Trade-mode **MockApe wait** defaults to **3 minutes** then proceeds without trade data (was 30 min).
- **`mic_diagnostics.json`** in each **record/trade** session folder when recording starts: `getUserMedia` success/failure, active audio track label + `deviceId` (when exposed), `enumerateDevices` snapshot for `audioinput`. Main logs a one-line **`recorder` / `mic capture summary`**. Use for “no audio” / wrong-default-mic support (Snipalot still uses OS default input; no in-app mic picker yet).
- **Frame picker:** Export uses `recording.mp4` inside the session directory (not the parent folder).
- **Hotkeys:** README, launcher hints, and logs aligned with `config.ts` (e.g. trade marker `Ctrl+Shift+X`, trade toggle `Ctrl+Alt+T`).
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
  - Launcher now exposes **Abandon** during post-stop `processing`. For normal recordings it cancels the in-flight pipeline, deletes the current session folder, and resets Snipalot to idle. For trade sessions, newer local-branch behavior queues a discarded-session audit instead of deleting the folder.
  - Abandon cancels the in-flight pipeline. Normal recording abandons delete the session folder; trade-mode abandons should preserve/audit the finalized WebM under `Inputs/`.
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
  - The HUD snapshot camera tooltip now uses the configured `snapshot` hotkey from main state (default `Ctrl+Alt+P`) instead of a hardcoded description, and pause/annotate tooltips also track configured hotkeys.
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
 - Recorder shortcut fail-safe passed build/static review and Pass 3 was appended to `docs/recording-shortcuts-issue-log.md`; legacy validation notes refer to the former `Ctrl+Shift+S` and `Ctrl+Shift+T` defaults.
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
- **Recording outline edge clamp (local branch):**
 - Root cause for missing trade-region border was visual clipping, not missing IPC: the recording outline was drawn outside the selected rectangle, so full-screen or edge-aligned regions like `x=0,y=0` clipped the top/left border off-screen.
 - `src/overlay/overlay.ts` now clamps the dashed recording outline to the visible overlay canvas so Record/Trade regions that touch display edges still show a border. Verify with `npm run build` and `npm test`.
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
 - `Ctrl+Alt+P` / configured snapshot hotkey is now registered globally: idle state starts the normal Screenshot flow using the current capture mode/cursor display, recording state still closes a snapshot chapter through the HUD snapshot path.
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
 - Screenshot hotkey cancel is debounced for 600 ms after entering `selecting-screenshot`, avoiding immediate toggle-off when Windows/Electron emits a repeat for the screenshot hotkey.
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
- **Trade sync incomplete-session guard (2026-05-23):**
 - The normal importer and `-ArchiveOnly` now classify current `* trade` folders before processing and only treat a folder as ready when `trade_log.xlsx` (or legacy `trade_log.csv`) is readable and has at least one data row. Missing, empty, unreadable, or still-being-written logs are reported in `skippedFolderDetails` and left in place.
 - `importTradeFolder()` also has a defensive missing-log guard, so an incomplete/current recording folder cannot be archived even if a caller reaches it directly.
 - Trade generation now writes root-level `session_complete.json` after `trade_log.xlsx`, `trade_log.md`, and `Inputs/adherence_report.md` are written. Sync still keys off the final workbook so older completed sessions remain compatible.
 - The deployed live script at `E:\OneDrive\Snipalot Captures\Trade Sync Scripts\sync-master-trading-log.mjs` was updated to match the repo mirror. Validation: `node --check tools\sync-master-trading-log.mjs`, `node --check` on the live script, `npm test`, and a temp-root sync proving missing/unreadable folders were skipped and not archived.
- **NICS workbook schema repair (v1.0.47 local branch):**
 - Generated session `trade_log.xlsx` now uses the same 55-column shape as `tblTrades`: source fields, workflow fields, Hour/Weekday/WeekdayNum/TimeBucket, then NICS/meta fields. The workbook no longer emits the old 47-column session-only shape.
 - Trade generation now runs a focused NICS backfill pass when the first Gemini/API extraction omits required N/I/C/S classifications. The pass writes `Inputs/nics_response.json`, merges the graded fields before output, and leaves history-dependent fields such as `meta_cluster_id`, cooldown, and running count to sync.
 - Sync now also merges `Inputs/nics_response.json` when present and writes reconciled session workbooks back in the 55-column master-compatible shape.
 - 2026-05-19 repair: `E:\OneDrive\Snipalot Captures\20260519.1529 trade\trade_log.xlsx` was rebuilt to 55 columns and all 9 trades received NICS classifications; matching rows in `E:\OneDrive\Snipalot Captures\master trading log.xlsx` were updated through Excel COM so the workbook remains openable. Both workbooks were verified to open in Excel.
 - The structural reference workbook `E:\OneDrive\Snipalot Captures\Statements\master trading log.xlsx` was restored from backup after an experimental XML rewrite made it unopenable; do not use XML full-rewrite against that template without an Excel-open validation pass.
 - Validation/build: `npm test` and `node --check tools\sync-master-trading-log.mjs` passed on 2026-05-19. Local installer built at **`release/Snipalot-1.0.47-setup.exe`** with `npm run package:nopublish -- --config.win.signAndEditExecutable=false`. SHA256: `E3C0623C13CF60623DE7E29C77E92AF5FDB5EE04087969D381F5B1580317C18C`. Build killed a stale installed `Snipalot.exe` first, then completed successfully.
- **Sync-time NICS evidence generation (v1.0.48 local branch):**
 - `tools\sync-master-trading-log.mjs` now treats sync as the reconciliation authority for missing NICS fields. If session rows are missing `meta_name` or N/I/C/S scores/why fields, sync first merges `Inputs\nics_response.json`; if that cache is missing or incomplete, it regenerates the NICS response from `transcript.txt`, `prompt.txt`, `Inputs\extraction_response.json`, `Inputs\mockape.json`, and `Inputs\markers.json`, then writes the audit cache back to `Inputs\nics_response.json`.
 - The sync script now prefers the canonical root workbook `E:\OneDrive\Snipalot Captures\master trading log.xlsx`; `Statements\master trading log.xlsx` is only a fallback/reference workbook. `--master` or `SNIPALOT_MASTER_TRADING_LOG` can override this.
 - Master XML rewrites no longer add a worksheet-level `autoFilter` over the Excel table filter; this was the cause of repeat sync outputs that Excel refused to open. Always keep an Excel-open validation pass after changing this writer.
 - Validation on 2026-05-19: fresh temp sync generated `Inputs\nics_response.json` for `20260519.1529 trade` from saved evidence, merged 9 NICS rows, rewrote the session workbook, and imported into a temp copy of the Statements master. Excel COM verified both temp workbooks open (`Master Trading Log` 337x55, `Trade Log` 10x55).
 - Validation/build: `npm test` passed on 2026-05-19. Local installer built at **`release/Snipalot-1.0.48-setup.exe`** with `npm run package:nopublish -- --config.win.signAndEditExecutable=false`. SHA256: `A90D67821A24B1B2F8B191F03BD5C7AE08AAF483EC499DB1DBB62F0D811B772A`. Build killed a stale installed `Snipalot.exe` first, then completed successfully.
- **Trade sync wrapper alignment (2026-05-19):**
 - `run-trade-sync.ps1` and `finalize-master-workbook.ps1` now resolve the same master workbook as the Node importer: explicit `-MasterPath`, `SNIPALOT_MASTER_TRADING_LOG`, then root `master trading log.xlsx`, then `Statements\master trading log.xlsx` as fallback/reference only.
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
- **Cluster-level cooldown signal (2026-05-23):**
 - Sync cooldown is based on completed losing meta clusters within the same `source_session`, not the immediately previous losing row. A trade gets `cooldown_ok=0/false` only when it starts within five minutes after a different session-level meta cluster is fully closed and that cluster's combined P&L is negative.
 - The importer uses `source_session + meta_cluster_id` as the cooldown/profit grouping key, completion time from the latest exit time in that group, and summed `pnl_sol` when complete for all rows, otherwise summed `pnl_percentage` as fallback.
 - Cooldown is informational only because entry/exit times are inferred and can vary by minutes. It does not block `counts_toward_50` and does not cause `hard_reset`; oversize trades remain the hard-reset condition.
 - `counts_toward_50` requires N+I+either C/S, exact 0.5 SOL, and `zone_ok=true`; outside-zone trades do not reset the counter, but they do not count.
 - `NICS_score` is now the unlock score `N_score + I_score + max(C_score, S_score)` instead of requiring both C and S. Generated session workbooks leave `counts_toward_50` blank before sync because sync owns history-dependent eligibility.
- **Session-local recording media isolation (local branch):**
 - `src/main/pipeline.ts` now writes `recording.webm` and durable `recording.mp4` inside each session folder instead of using parent-level fixed temp files as the processing source. `Inputs/recording.wav` remains an intermediate and is removed after Whisper.
 - The parent output root still receives a best-effort `recording.mp4` copy for the "latest recording" convenience, but GIF, transcript, frame extraction, and trade pipeline all use the session-local MP4. This prevents overlapping processing runs from overwriting each other's media and leaves a reviewable MP4 in failed/incomplete session folders.
 - `Inputs/processing_log.jsonl` now records session WebM write, session MP4 write, latest-copy success/failure, and WebM cleanup/retention.
 - `organizeTradeSessionRoot()` keeps root `recording.mp4` alongside GIF, `prompt.txt`, `transcript.txt`, `trade_log.xlsx`, and `trade_log.md`; normal recording Abandon deletes the folder, while trade-mode Abandon is now handled by the discarded-session audit flow.
- **Launcher update notice (v1.0.53 local branch):**
 - The primary launcher checks GitHub releases on startup and only shows an update row when an installer update is available.
 - The row appears under the launcher buttons/shortcut hints and reads `Snipalot <version> is available. Click here to install.`
 - The launcher uses the same installer download/launch path as Settings and asks main to resize the launcher only while the update row is visible. Settings footer copy now also says `click here to install`.
 - May 4 reconstruction helper scripts were archived outside the repo at `E:\OneDrive\Snipalot Captures\Archive\developer-tools\20260520-may4-reconstruction-scripts` and removed from the working tree because they were one-off scripts with hard-coded local paths.
- **Trade sync finalizer RPC hardening (local branch):**
 - `tools\finalize-master-workbook.ps1` now wraps `Get-LastNonBlankRow()` cell reads in `Invoke-ExcelRetry`, fixing an Excel COM `RPC_E_CALL_REJECTED` failure while scanning `Analysis!Q`.
 - The deployed copy at `E:\OneDrive\Snipalot Captures\Trade Sync Scripts\finalize-master-workbook.ps1` was updated. A clean rerun finalized `E:\OneDrive\Snipalot Captures\Statements\master trading log.xlsx` successfully (`tblTrades` `A1:BC361`, 55 columns).
- **Root master workbook restored as sync target (2026-05-20):**
 - `tools\sync-master-trading-log.mjs`, `tools\run-trade-sync.ps1`, and `tools\finalize-master-workbook.ps1` now prefer `E:\OneDrive\Snipalot Captures\master trading log.xlsx` before the temporary `Statements` workbook. The live deployed scripts under `E:\OneDrive\Snipalot Captures\Trade Sync Scripts\` were updated to match.
 - `sync-master-trading-log.mjs` accepts `--include-session` / `--session`, and the PowerShell wrapper accepts `-IncludeSession`, so archived repair imports can target named sessions without crawling every archived trade folder and regenerating old NICS classifications.
 - Validation: backed up the root master, then ran targeted archive backfill for `20260519.1529 trade`, `20260519.1710 trade`, `20260519.2002 trade`, and `20260520.0828 trade` into the root master. Result: root `tblTrades` verified via Excel COM as `A1:BC42`, 55 columns, with session counts 9, 16, 2, and 6 respectively.
- **Root master chart/finalizer compatibility check (2026-05-20):**
 - User-edited root workbook was audited after adding helper cells/charts. `tblTrades` stayed `A1:BC42` with the expected 55 columns and zero header mismatches; `tblAnalysis` stayed `A1:O42`.
 - `finalize-master-workbook.ps1` now preserves the split win/loss `P&L % per Trade (wins green, losses red)` chart by refreshing series named `P&L % (Win)` from `Analysis!BL` and `P&L % (Loss)` from `Analysis!BM`. Old one-series charts still fall back to `Analysis!AK/AQ`.
 - Excel COM retry attempts increased to handle transient `RPC_E_CALL_REJECTED` during `FillDown()`. Validation used a temp copy at `master trading log.sync-validation-temp.xlsx`; repair/finalize passed and OpenXML inspection confirmed `tblTrades` `A1:BC42`, `tblAnalysis` `A1:O42`, and the win/loss chart series still pointed to `Analysis!BL2:BL42` and `Analysis!BM2:BM42`.
- **Root master BO formula-column compatibility (2026-05-25):**
 - Live root workbook audit found `tblTrades` at `A1:BO157`; extra columns `BD:BO` are table calculated columns, including `BO` / `trade_num_in_session` with `COUNTIFS($A$2:$A2,$A2)`.
 - `tools\sync-master-trading-log.mjs` accepts the current workbook shape because the first 55 columns still match `MASTER_COLUMNS` and all extra columns are calculated table columns. Temp import validation appended one synthetic legacy-CSV row and extended `tblTrades` to `A1:BO158`, with `BO158` filled as `COUNTIFS($A$2:$A158,$A158)`.
 - `tools\finalize-master-workbook.ps1` no longer hard-codes `tblTrades` to `A1:BJ`; it now resizes to the greater of the current table width and the last nonblank header column, preserving `BO` and future calculated table columns. The deployed OneDrive finalizer was updated to match the repo copy.
 - Follow-up repair after a live sync imported `20260525.1029 trade`: Excel COM disconnected at `Analysis.Calculate()`, leaving the imported rows saved but the `Analysis` sheet not filled through row 182. The finalizer now saves formula/chart propagation before optional Excel calculation, uses non-fatal calculation attempts, and explicitly fills Master calculated columns `BD:BO` from row 2 R1C1 formulas after table resize.
 - Ran live `run-trade-sync.ps1 -RepairOnly`; it made no imports/archive moves, filled `Analysis` through `A182:O182`, preserved `tblTrades` at `A1:BO182`, and verified Master trailing formulas as Excel shared formulas in `BD182`, `BJ182`, `BN182`, plus direct `BO182 = COUNTIFS($A$2:$A182,$A182)`.
- **Recorder/trade diagnostics hardening (local branch):**
 - Investigation of `20260520.1616 trade`, `20260520.1643 trade`, and `20260520.1646 trade` found only `mic_diagnostics.json` plus empty `Inputs`, with no recoverable session-local media. That means the recorder reached mic/session creation but did not reach `save-webm`/pipeline handoff; these folders predate the richer `processing_log.jsonl` evidence seen in `20260520.1720 trade`.
 - Main now writes session-local diagnostics when stop is requested before MediaRecorder is ready, when stop is snapshotted for processing, and when the processing watchdog fires before `save-webm`/pipeline completion.
 - Future `mic_diagnostics.json` files include `appVersion` so support can correlate capture failures with the installed Snipalot build.
 - Trade extraction parsing now skips spoken-only rows with no `token_name` and no `mockape_trade_id` instead of rejecting the whole response. This prevents one non-executed setup/musing from blocking matched trades from generating `trade_log.xlsx`.
- **Recorder lifecycle flight recorder (v1.0.55 local branch):**
 - Recorder renderer now emits sanitized lifecycle events for start receipt, `getDisplayMedia`, mic capture, crop computation, MediaRecorder creation/start, first and periodic data chunks, stop receipt, `onstop`, WebM blob assembly, and `save-webm` IPC handoff.
 - Main buffers recorder lifecycle events that occur before the session folder exists, then flushes them into `Inputs/processing_log.jsonl` once `liveSessionDir` is created. This is meant to distinguish future missing-recording failures: no stop sent, renderer crash, no `onstop`, zero-byte blob, or missing main `save-webm`.
 - Validation: `npm.cmd test` passed after the lifecycle IPC/preload/session-log changes.
- **Launcher update download progress (v1.0.56 local branch):**
 - The primary launcher update banner now listens for update-download progress events and renders the same percent/bytes status that Settings already showed.
 - Main sends update progress on `launcher:update-download-progress` when the update install is initiated from the launcher, while Settings continues using `settings:update-download-progress`.
 - Validation: `npm.cmd test` passed after the launcher IPC/UI update.
- **Session manifest diagnostics (v1.0.57 local branch):**
 - Each new record/trade session now writes `Inputs/session_manifest.json` as soon as `liveSessionDir` is created, before Whisper/MP4/GIF/Gemini processing can fail.
 - Manifest includes app version, packaged/dev state, process/runtime paths, session mode, output root, active display/source, region percentages, display geometry, config path, and a sanitized config summary. API keys are not written; only key-presence booleans are included.
 - Validation: `npm.cmd test` passed after adding the manifest writer.
- **Launcher update banner polish (v1.0.58 local branch):**
 - The launcher update banner is now vertically balanced in the lower free space below the shortcut row instead of sitting tight under the primary controls.
 - Available-update state uses red/attention styling; active install/download state switches to green/progress styling.
 - Validation: `npm.cmd test` passed after the launcher CSS/state update.
- **Undo hotkey safety (v1.0.59 local branch):**
 - `Ctrl+Z` is now treated as local-only for annotation undo and is not registered through Electron `globalShortcut`, preserving normal Undo behavior in Word, Excel, Notepad, browsers, and other apps.
 - Settings highlights the local-only `Ctrl+Z` undo binding and recommends `Ctrl+Alt+Z` when a user explicitly wants a global recording undo shortcut.
 - Validation: `npm.cmd test` passed after changing this behavior.
- **Installer taskbar icon cleanup (v1.0.60 local branch):**
 - Root cause: local installers built with `--config.win.signAndEditExecutable=false` do not embed the app icon into `Snipalot.exe`, and older per-user Start Menu shortcuts can remain beside the newer all-users shortcut with stale taskbar identity metadata.
 - Installer now deletes the legacy per-user `Snipalot.lnk` during install/uninstall, then recreates the active shortcut with the generated Snipalot `.ico` and `app.snipalot` AppUserModelID.
 - Validation: after packaging, extract the installed or unpacked EXE icon with `[System.Drawing.Icon]::ExtractAssociatedIcon()` and confirm it is the red Snipalot icon, not Electron.
- **Gemini long-session fallback hardening (v1.0.61 local branch):**
 - `20260521.1757 trade` produced transcript/MP4/GIF/prompt/MockApe but initially no `trade_log.xlsx` because Gemini CLI auto-extraction failed after the first 5-minute attempt and fell back to the manual response path without enough session-local stderr/timeout detail.
 - Repaired that folder by generating `Inputs/extraction_response.json` from `prompt.txt` via Gemini CLI positional-prompt mode, then finalized the existing trade pipeline outputs. The folder now has `trade_log.xlsx`, `trade_log.md`, `Inputs/adherence_report.md`, and `Inputs/nics_response.json`.
 - Code now gives the first `--prompt` Gemini attempt a capped 5-minute window, retries positional-prompt mode on parser conflict or first-attempt timeout, allows the fallback up to 15 minutes, and writes sanitized Gemini stderr/stdout tails plus timeout/code details to `Inputs/processing_log.jsonl`.
 - Validation: `npm.cmd test` passed after the Gemini fallback/diagnostic change.
- **Taskbar stale shortcut cleanup hardening (v1.0.62 local branch):**
 - Investigation found the installed `C:\Program Files\Snipalot\Snipalot.exe` had the correct red icon, but a legacy per-user `Snipalot.lnk` from May 5 still existed beside the all-users shortcut and Windows continued showing stale Electron taskbar icon metadata.
 - The installer cleanup now explicitly switches NSIS to `SetShellVarContext current` before deleting the legacy per-user shortcut, then switches back to `all` before recreating the all-users shortcut with the Snipalot `.ico` and AppUserModelID.
 - Manual remediation used: delete `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk` and `Electron.lnk`, clear `%LOCALAPPDATA%` icon caches, restart Explorer, then launch Snipalot from the all-users shortcut.
- **Launcher idle height balance (v1.0.63 local branch):**
 - The no-update launcher window height was reduced so the primary action buttons and shortcut row no longer sit above a large empty bottom band.
 - The update-banner height remains larger, preserving room for the install/download message when an update is available.
 - Validation: `npm.cmd test` passed after the launcher sizing change.
- **Update check cache refresh (v1.0.64 local branch):**
 - Root cause for installed v1.0.61 still showing "Up to date" after newer releases: successful update checks were cached for the entire app process.
 - Settings/manual update checks now force a fresh GitHub latest-release request; background/launcher checks use a 5-minute cache TTL instead of an indefinite cache.
 - Update-check logs now include cache age/TTL and whether the cache was bypassed for faster release-status troubleshooting.
- **Shared-folder session status flags (v1.0.65 local branch):**
 - Every recording/trade session now writes root-level `session_status.json` and `SESSION_STATUS.txt` files so a synced OneDrive viewer can see whether the session is `recording`, `processing`, `complete`, `failed`, `stalled`, `abandoned`, or `discarded`.
 - `recording` and `processing` statuses refresh every 15 seconds with `lastHeartbeatIso`; if OneDrive shows an old heartbeat and `terminal=false`, the session is stale rather than actively running.
 - Status is updated at recorder start, stop/finalization handoff, `save-webm`, pipeline step changes, completion, failure, watchdog stall, discard, abandon, and app exit during recording/processing.
- **Discard cleanup hardening (v1.0.66 local branch):**
 - Confirmed empty trade folders with only `mic_diagnostics.json` match a user pressing Discard after recorder start but before finalization; no trade outputs are expected in that path.
 - Discard now tracks the session folder separately until the discarded `save-webm` callback arrives, so cleanup can run both immediately and after MediaRecorder unwinds.
 - Session folder deletion now retries after 1s, 5s, 15s, 60s, and 180s if OneDrive or Windows briefly keeps newly-created diagnostics locked.
- **Trade discard audit flow (local branch):**
 - Trade-mode Discard no longer deletes the session folder immediately. When the finalized `save-webm` buffer arrives, Snipalot saves it as `Inputs/discarded_recording.webm`, transcribes directly from WebM to `Inputs/transcript.txt` without creating an MP4, writes `Inputs/markers.json`, `Inputs/annotations.json`, and `Inputs/discarded_trade_review.{json,md}`, and updates root `session_status.json` / `SESSION_STATUS.txt` with review comments.
 - The audit uses trade markers plus trade-language transcript/annotation evidence to flag `potential_trade_activity` with estimated timestamps. If no trade evidence is found after transcription, it deletes `Inputs/discarded_recording.webm` while preserving transcript, status, markers, screenshots, and annotations. If evidence is found or transcription cannot rule activity out, it retains the WebM for review.
 - Marker screenshots remain under `Inputs/trade-screenshots/`; regular snapshot PNGs captured during discarded trade sessions are copied into `Inputs/discarded-snapshots/` for easier review.
 - Follow-up hardening after local test: trade-mode **Abandon** during processing now queues the same audit instead of deleting the folder, including the case where Abandon is clicked before `save-webm` arrives. App-exit requests during an active trade recording are converted into the confirmed **Discard and audit** flow instead of immediately closing windows and leaving a stale `recording` session without a finalized WebM.
 - Follow-up after `E:\Snipalot Captures\20260524.0056 trade`: if the user stops a trade and then clicks **Abandon** after the normal pipeline has already started, the pipeline may have written root-level `recording.webm` and a partial `recording.mp4` before abort. The abandoned-trade audit path now deletes root pipeline media (`recording.mp4`, `recording.webm`, `recording.gif`, and `Inputs/recording.wav`) before/after audit while preserving `Inputs/discarded_recording.webm` when evidence requires retention.
 - Validation: `npm run build` and `npm test`.
- **Launcher update banner refresh (v1.0.67 local branch):**
 - Root cause: Settings forced a fresh update check, but the already-open launcher only checked on boot and did not receive the Settings result.
 - Main now pushes every completed update-check result to the launcher via `launcher:update-check-result`.
 - Launcher applies pushed results and also refreshes update status every 60 seconds; the update banner still hides and keeps compact launcher height when no update is available.
- **Screenshot cancel + launcher hotkey fallback (local branch):**
 - Screenshot/record/trade region selection now registers a selection-only global `Escape` handler in main, so the launcher leaves `Cancel` state even when the overlay renderer does not own keyboard focus.
 - Launcher also handles its configured screenshot hotkey while focused and forwards it through the normal `launcher:screenshot` IPC path, giving the screenshot shortcut a focused-window fallback when Electron's global shortcut path does not fire.
 - Recurring screenshot-start diagnostics: config load now logs current hotkeys/capture mode, global shortcut registration logs `registeredBefore`/`registeredAfter`, the snapshot registration is rechecked after 250 ms with `globalShortcut.isRegistered()`, launcher main-process `before-input-event` logs and handles the screenshot hotkey when the launcher is focused, and launcher renderer logs snapshot-like keydowns with match/failure details.
 - Follow-up after logs showed `Ctrl+Shift+P` registered with `isRegistered:true` but produced no global or launcher keydown event: `Ctrl+Alt+P` was proven to work locally and is now the default screenshot hotkey. `src/main/config.ts` migrates existing configs still on old default `hotkeys.snapshot = Ctrl+Shift+P` to `Ctrl+Alt+P` on load; custom screenshot bindings are preserved and covered by `tests/config-persistence.test.mjs`.
 - Follow-up hardening: main now intercepts `Escape` from both overlay and launcher `before-input-event` and routes it to `exitSelecting()` before default close/quit behavior can run. Launcher close requests, shared app-exit requests, and Electron `window-all-closed` events during active selection now cancel selection and return to idle instead of exiting the app.
 - Annotator/editor hardening: screenshot annotator windows now intercept `Escape` in main, log `annotator` Escape/close lifecycle events, forward the key to the renderer, and prevent any close request that lands immediately after Escape unless it came from an explicit Save/Cancel/app-exit path. Renderer Escape now logs context and only cancels crop/prompt/inline edit/selection state.
 - Follow-up after dev logs showed the process disappeared immediately after the synchronous global `Escape` callback entered `exitSelecting()`: the global `Escape` shortcut now queues selection cancel with `setTimeout(..., 0)` so Snipalot does not unregister/re-register global shortcuts from inside the active `globalShortcut` dispatch. Launcher visibility is logged/restored/focused after cancel, and process-level `uncaughtException` / `unhandledRejection` / `exit` logs were added.
 - Validation: `npm run build` and `npm test`.
- **Incremental feedback transcription + media-output toggles (local branch):**
 - Hidden recorder now runs a rolling audio-only recorder in 30s chunks while the main WebM recorder continues normally. Main enqueues those chunks for local Whisper transcription during recording and writes session-local `whisper` events to `Inputs/processing_log.jsonl`.
 - `runPipeline()` uses the incremental transcript when all live chunks finish cleanly. If no chunks arrive, Whisper is missing, or any chunk fails, it falls back to the previous full post-stop WebM -> WAV -> chunked Whisper path.
 - Settings now has **Feedback Outputs** toggles for standard Record sessions: **Generate MP4 copy** and **Generate GIF preview**. Both default off for feedback recordings. Trade sessions ignore these toggles and still generate the MP4/GIF artifacts expected by trade reports.
 - When feedback MP4 output is disabled but annotation/snapshot frame extraction needs video, pipeline creates a temporary `Inputs/recording.preview-source.mp4`, derives the PNG/GIF artifacts needed, then deletes the temporary MP4.
 - Validation: `npm run build` and `npm test`.
- **State hotkey rearm guard (local branch):**
 - `Ctrl+Shift+S` and `Ctrl+Shift+T` now enter a short rearm window after firing so `reloadGlobalHotkeys()` does not immediately unregister/re-register the same chord while the physical keys are still down. This prevents the observed idle/selecting runaway loop where `Ctrl+Shift+S` repeatedly toggled state in milliseconds and locked the machine.
 - Global shortcut callbacks now run through a dispatch wrapper. If a callback-triggered state transition asks for `reloadGlobalHotkeys()`, the reload is queued until the callback exits, avoiding the earlier app-close failure caused by `globalShortcut.unregisterAll()` running inside Electron's active shortcut dispatch.
 - During the rearm window, the deferred reload skips the state-changing hotkey and registers it again after the guard expires. Snapshot, annotation, pause, clear, and outline shortcuts keep their prior behavior, but their callbacks also use the same dispatch wrapper.
 - Validation: `npm run build` and `npm test`.
- **Pinned taskbar icon repair (v1.0.68 local branch):**
 - Installer `customInstall` now repairs an existing per-user pinned `Snipalot.lnk` under `$QUICKLAUNCH\User Pinned\TaskBar`, rewriting its target, red-dot icon path, and AppUserModelID. This prevents stale Electron taskbar shortcut metadata from surviving upgrades when Snipalot was pinned during an older/dev build.
 - The installer still does not pin Snipalot for users who have not pinned it; it only repairs an existing pinned shortcut.
- **Recorder/frame-picker taskbar icon fix (v1.0.69 local branch):**
 - Root cause of the recurring Electron taskbar icon after v1.0.68: the installed EXE, Start Menu shortcut, and AppUserModelID were already correct, but the hidden recorder `BrowserWindow` was created without `skipTaskbar` and without the Snipalot icon. Windows could surface that auxiliary window as a separate Electron-icon taskbar button when recording/capture surfaces initialized.
 - The recorder window now uses the Snipalot icon and stays out of the taskbar in normal runs (`skipTaskbar: !isDebug`). The frame picker window now also gets the Snipalot icon.
- **All-window taskbar icon hardening (v1.0.70 local branch):**
 - Follow-up live inspection showed the three visible overlay windows had no `WM_GETICON` handles and only inherited Electron's class icon, while the launcher and installed EXE already had the red-dot icon. Windows can choose a visible overlay as the taskbar group representative even though overlays are `skipTaskbar:true`, causing the group icon to show Electron.
 - Every Snipalot `BrowserWindow` now receives the app icon in constructor options where applicable and then calls `win.setIcon(appWindowIcon())` immediately after creation. This explicitly sets window-level icon handles for launcher, overlays, recorder, HUD, annotator, trade-context, response-paste, settings, and frame-picker windows.
- **Stale Electron shortcut identity cleanup (v1.0.71 local branch):**
 - v1.0.70 still showed the Electron taskbar icon even though logs confirmed Snipalot icons were applied to launcher/overlay/recorder windows. Shell enumeration found a legacy per-user `Electron.lnk` under `%APPDATA%\Microsoft\Windows\Start Menu\Programs` targeting the repo's dev `node_modules\electron\dist\electron.exe`, with `AppUserModelId=app.snipalot`.
 - Installer cleanup now deletes stale `Electron.lnk` shortcuts from current-user Start Menu, current-user pinned taskbar, and all-users Start Menu before recreating the canonical all-users `Snipalot.lnk` with `app.ico` and `app.snipalot`. Dev runs now use `app.snipalot.dev` while packaged builds keep `app.snipalot`, preventing future dev `electron.exe` shortcuts from sharing the production taskbar identity. `tests/installer-shortcut-cleanup.test.mjs` guards this path.
- **Master trade sync formula-column compatibility (local branch):**
 - `master trading log.xlsx` now has formula-driven cooldown/cluster columns `BD:BJ` after the 55 imported trade-log columns. `tools/sync-master-trading-log.mjs` now treats trailing `tblTrades` columns as valid only when they are Excel table calculated columns, extends the table through them, and writes formulas into appended rows instead of hard-coded values.
 - The deployed OneDrive mirror at `E:\OneDrive\Snipalot Captures\Trade Sync Scripts\sync-master-trading-log.mjs` was updated to the same SHA as the repo script. Temp validation against a copied workbook appended a row, expanded `tblTrades` to `A1:BJ89`, and produced formula cells in `BD89:BJ89` with no cached values.
 - Follow-up after an `EBUSY` locked-workbook failure: current-folder archiving is now delayed until after `saveMaster()` succeeds, and workbook writes retry transient `EBUSY`/`EPERM`/`EACCES` locks. `run-trade-sync.ps1` closes the master workbook only when Excel has it open and already saved; if it has unsaved changes, sync aborts before import. Temp validation confirmed a locked master exits nonzero while leaving the trade folder unarchived.
 - Finalizer compatibility: `tools/finalize-master-workbook.ps1` originally moved past the old `BC` boundary to preserve cooldown calculated columns; as of 2026-05-25 it dynamically resizes `tblTrades` through the greater of the current table width and the last nonblank header column, preserving the later `BO` / `trade_num_in_session` formula column as well.
- **WilyTrader bridge intake (local branch):**
 - Trade recordings now start a localhost-only bridge at `127.0.0.1:17365`; the WilyTrader Chrome extension can POST its full ledger to `/v1/wilytrader/ledger`, which writes `Inputs/wilytrader.json` into the active trade session.
 - `src/main/trade-pipeline.ts` treats `Inputs/wilytrader.json` as an automatic trade-data decision and normalizes its closed positions / `mockapeCompatibleTrades` into the existing compact MockApe join shape, so older `mockape.json` workflows still work.
- **Trade log entry-time label compatibility (local branch):**
 - Generated session `trade_log.xlsx` now labels the existing `entry_time_inferred` column position as `entry_time_actual` for the user-facing workbook, and `trade_log.md` uses the same label. The internal row key and master `tblTrades` schema remain `entry_time_inferred` so the existing 55-column import shape is not moved.
 - `tools/sync-master-trading-log.mjs` treats session headers named `entry_time_actual` as an alias for `entry_time_inferred` and writes repaired session workbooks with the new display label, preserving sync compatibility while allowing the visible label to evolve.
- **Overlay drawing/display-change race hardening (local branch):**
 - Root cause found for intermittent region-select / drawing weirdness: Windows display-change events rebuilt all overlay windows immediately and `rebuildOverlays()` cleared the overlay map even if a close was prevented during active selection, which could orphan transparent overlay windows.
 - Display-change overlay rebuilds are now debounced; active region selection is cleanly cancelled before rebuild; rebuilds defer during recording/processing. Overlay renderer console/load/preload/crash diagnostics now land in `snipalot.log`.
 - Validation: `npm run build` and `npm test`.
- **v1.1.1 release build:**
 - Bumped Snipalot from `1.1.0` to `1.1.1` after overlay rebuild, WilyTrader bridge, trade-log label, and master trade-sync compatibility fixes.
 - `npm test` passed, and the light NSIS installer built at `release/Snipalot-1.1.1-setup.exe` with `npm run package:nopublish -- --config.win.signAndEditExecutable=false` due the known local `winCodeSign` symlink privilege issue.
 - SHA256: `00BD4263DF45C22E9F648B84B8512F95B201A49228A741BE80B5DCE43681B480`.
- **WilyTrader launcher update flow (v1.1.2 local branch):**
 - Launcher now checks WilyTrader GitHub tags separately from Snipalot app releases and can show a second home-screen update banner.
 - WilyTrader update target detection prefers the existing Chrome unpacked-extension path from Chrome profile Preferences, then `WILYTRADER_HOME`, common local folders, and only then a Snipalot-managed fallback folder.
 - If no existing folder is found, clicking the WilyTrader banner asks the user to select the repo/extension folder, use a managed folder, or cancel. Selected folders are validated against WilyTrader `manifest.json` before files are written.
 - Updates use `git pull --ff-only` when the target is a Git checkout; otherwise Snipalot downloads the latest WilyTrader tag ZIP, overwrites the existing folder contents, and opens `chrome://extensions` so the user can manually click Reload on the unpacked extension.
 - Validation: `npm test`.
- **WilyTrader first-install UX fix (v1.1.3 local branch):**
 - Selecting a folder now accepts an empty custom folder as a WilyTrader install target instead of requiring an existing `manifest.json`; non-empty non-WilyTrader folders are still rejected.
 - After install/update, Snipalot opens the final `extension` folder in Explorer, copies that Load unpacked path to the clipboard, opens `chrome://extensions/`, and shows a native completion dialog with the exact folder paths and manual Chrome steps.
 - The launcher keeps the WilyTrader success banner visible after completion instead of immediately hiding it.
- **WilyTrader settings status + hotkey defaults (v1.1.4 local branch):**
 - Settings now shows WilyTrader installed version plus the clickable Load unpacked folder near the bottom of the window; the folder opens in Explorer through main-process IPC.
 - Default shortcuts are now `Ctrl+Alt+S` for feedback recording, `Ctrl+Alt+T` for Trade, and `Ctrl+Alt+P` for screenshot/snapshot. Config load migrates users still on the old default `Ctrl+Shift+S` / `Ctrl+Shift+T`; custom bindings are preserved.
- **WilyTrader migration controls (v1.1.5 local branch):**
 - Config now has `wilyTrader.installPath`; WilyTrader detection prefers that saved folder before Chrome profile paths, environment variables, or common folders.
 - Settings adds **Move Location** to move WilyTrader files to an empty folder or point Snipalot at an existing WilyTrader folder, then refreshes the visible Load unpacked path.
 - Settings adds **Open Chrome Extensions** for the manual Chrome remove/load/reload step after moving the folder. Snipalot cannot rewrite Chrome's unpacked-extension path directly.
- **WilyTrader move EPERM fix (v1.1.6 local branch):**
 - `Move Location` now clarifies that it moves the whole WilyTrader files folder; Chrome should load the `extension` subfolder.
 - Windows `EPERM` / `EACCES` directory rename failures now fall back to copy-verify-delete. If Windows refuses to remove the old folder, Snipalot still saves the new verified folder and tells the user the old folder can be deleted manually later.
- **Chrome Extensions handoff fix (v1.1.7 local branch):**
 - Settings closes itself before opening Chrome Extensions so the always-on-top Settings window does not cover Chrome.
 - Chrome handoff no longer passes `--new-window`; it passes the extensions URL to Chrome so an already-running Chrome instance can route it through the active/recent profile instead of forcing the profile picker.
 - If Chrome Preferences already contain a WilyTrader extension id, the handoff uses `chrome://extensions/?id=<id>`; otherwise it falls back to `chrome://extensions/`.
- **Chrome profile-targeted extension handoff (v1.1.8 local branch):**
 - Chrome Extensions handoff now passes `--profile-directory=<profile>` to Chrome. It prefers the profile where WilyTrader is already installed, then Chrome's `Local State` last-used profile, then `Default`.
 - This avoids Chrome's profile picker on multi-profile installs while still using Chrome's own current profile metadata rather than hardcoding a user/profile.
- **Chrome Extensions delayed navigation retry (v1.1.9 local branch):**
 - The Settings **Open Chrome Extensions** button now uses a two-stage Windows Chrome handoff: first activate the selected Chrome profile, then after a short delay open `chrome://extensions/` or the known WilyTrader extension URL in a new tab.
 - This handles the case where Chrome accepts the profile handoff but drops the internal `chrome://` navigation from the initial launch command.
- **Chrome Extensions clipboard navigation (v1.1.10 local branch):**
 - Windows Chrome handoff now opens one blank tab in the selected profile, temporarily places the Chrome Extensions URL on the clipboard, sends `Ctrl+L`, `Ctrl+V`, and `Enter`, then restores the previous clipboard text.
 - This avoids Chrome's command-line filtering of `chrome://` URLs while avoiding visible character-by-character typing.
- **Screenshot annotator export cleanup (local branch):**
 - `snapshot.png` export now clears the active annotation/overlay selection and renders annotations in final mode, so selected resize handles and dashed selection borders are not baked into the saved screenshot.
 - Annotation note/comment text is no longer stamped as a legend inside the image; notes stay in `prompt.md` / clipboard prompt where they do not block the visual reference.
 - Validation: `npm test`.
- **Windows executable icon release invariant (local branch):**
 - Root cause of the latest Electron taskbar icon recurrence: `win.signAndEditExecutable: false` had been committed as the default package config in v1.1.11. That lets local packages build without `winCodeSign`, but leaves `Snipalot.exe` with Electron's embedded icon. Any `Electron.lnk` / generic shortcut / taskbar grouping that falls back to the EXE icon can then show Electron again.
 - Default light/full packaging now leaves executable resource editing enabled and runs `scripts/assert-windows-icon.mjs` after packaging. The assertion compares the packaged `release/win-unpacked/Snipalot.exe` associated icon against `resources/icons/app.ico` and fails the package if they differ.
 - `tests/windows-icon-invariant.test.mjs` guards against reintroducing `signAndEditExecutable: false` in release configs and verifies normal package scripts run the icon assertion. `package:unsafe-no-icon-edit` is the explicit local-only escape hatch for the known `winCodeSign` symlink privilege failure and should not be used for release/install acceptance.
 - Validation: `npm test` passed. `npm run assert-windows-icon` correctly failed against the existing bad local artifact, and `npm run package:nopublish` failed earlier at `winCodeSign` cache extraction (`Cannot create symbolic link`), confirming this machine needs elevated/Developer Mode or CI for icon-correct packages.
- **Trade log actual entry time + token labels (local branch):**
 - Snipalot now carries WilyTrader `firstEntryAt` / first buy execution timestamps into generated trade rows as `entry_timestamp_ms`; the existing visible `entry_time_actual` column position remains schema-compatible, but it now uses the source ledger timestamp before falling back to transcript-derived inference.
 - WilyTrader-derived rows prefer real token display names over address-like labels. Snipalot preserves a non-address LLM token name if the source label is only a shortened mint address, and WilyTrader now includes entry timestamp, token address, and time-in-trade fields in `mockapeCompatibleTrades`.
 - Axiom token-name detection in WilyTrader now reads chart/header text such as `Save Snuggles/USD on Pump V1` before falling back to shortened addresses, so future Snipalot logs should show names like `Save Snuggles` instead of `7MoWsa...QAFB`.
 - Validation: `npm test` passed in Snipalot; `node --check E:\Apps\wilytrader\extension\src\content.js` passed.
- **Start Menu search regression repair (local branch):**
 - The installed machine had a valid all-users `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk`, but also a stale per-user `Electron.lnk` targeting `C:\Program Files\Snipalot\Snipalot.exe`, which can confuse Windows Search/taskbar identity.
 - Light/full `electron-builder` configs now disable built-in Start Menu shortcut creation; `resources/installer.nsh` owns shortcut creation explicitly, deletes stale `Electron.lnk`, and creates canonical current-user plus all-users `Snipalot.lnk` entries with the Snipalot icon and `app.snipalot` AppUserModelID.
 - Current machine remediation performed: removed `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Electron.lnk` and copied the canonical all-users `Snipalot.lnk` into the current-user Start Menu. Search indexing may still need a short Windows refresh delay.
 - Validation: `npm test` passed, including installer shortcut guards.
- **Version bump / release follow-up:** `package.json` bumped to `1.1.16` for the trade-log and Start Menu shortcut fixes above. The first `v1.1.14` and `v1.1.15` release workflows produced installers but failed the post-package icon assertion; `scripts/assert-windows-icon.mjs` now compares pixel similarity at the same frame size Windows extracts from the EXE, and `scripts/make-icon.mjs` now writes the multi-size `.ico` using classic 32-bit DIB frames instead of PNG-compressed ICO frames for better executable resource editing compatibility.

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

7. **Shortcut-triggered recording startup reliability:** Mitigations landed (queued-start fallback + timeout) and build/static verification passed. Defaults moved to `Ctrl+Alt+S` and `Ctrl+Alt+T`; track detailed passes in `docs/recording-shortcuts-issue-log.md`.

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
