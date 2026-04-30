# Snipalot — agent handoff notes

Use this file to onboard LLMs or humans picking up work without full chat context.

## Repo snapshot

- **Stack:** Electron 30, TypeScript (strict), main process in `src/main/index.ts`, renderers under `src/*`, post-processing in `src/main/pipeline.ts` and `src/main/trade-pipeline.ts`.
- **Build:** `npm ci` then `npm run build`. Run app: `npm run dev`.
- **Windows installer (local):** On a Windows machine, `npm run package` produces **`release/Snipalot-<version>-setup.exe`** (see `electron-builder.yml`). `package:portable` builds the portable exe.
- **Windows installer (CI / publishing):** Pushing a git tag matching **`v*`** (e.g. `v1.0.1`) runs **`.github/workflows/release-windows.yml`**, which builds on `windows-latest` and uploads **`Snipalot-*-setup.exe`** to a **GitHub Release** for that tag (`softprops/action-gh-release`). Bump **`package.json` `version`** before tagging so the filename matches the release.
- **Linux:** `npm run package` on Linux produces AppImage/Snap only, not the Windows setup exe.
- **End-user install:** **[GitHub Releases](https://github.com/Koprowski/snipalot/releases)** — download the latest **`Snipalot-*-setup.exe`**. Full Trade + Gemini walkthrough: **[Issue #2](https://github.com/Koprowski/snipalot/issues/2)** (update the pinned download link there when you ship a new version).
- **Config:** `%USERPROFILE%\.snipalot\config.json`; defaults in `src/main/config.ts`.

## Recent improvements (v1.0.1+)

- **`mic_diagnostics.json`** in each **record/trade** session folder when recording starts: `getUserMedia` success/failure, active audio track label + `deviceId` (when exposed), `enumerateDevices` snapshot for `audioinput`. Main logs a one-line **`recorder` / `mic capture summary`**. Use for “no audio” / wrong-default-mic support (Snipalot still uses OS default input; no in-app mic picker yet).
- **Frame picker:** Export uses `recording.mp4` inside the session directory (not the parent folder).
- **Hotkeys:** README, launcher hints, and logs aligned with `config.ts` (e.g. trade marker `Ctrl+Shift+M`, trade toggle `Ctrl+Shift+T`).
- **Snapshots:** Serialized in main so concurrent 📸 cannot cross-wire `recorder:snap-result`.
- **Settings:** Folder picker avoids a forced parent window when settings is closed.
- **Docs:** README links Releases + Issue #2 for exe vs dev install; production build uses `npm run package` → **`release/`**.

## Packaged app logs

Main file logger writes **`spike-output/snipalot.log`** relative to **process cwd** (often next to the installed app). If support cannot find it, search the PC for **`snipalot.log`**.

## Open items — intentional deferrals

These came from code review; **not** implemented yet. Pick up as separate tasks if desired.

1. **Unexpected recorder stop** (`recorder:state` → `stopped` while `appState === 'recording'`): Main snapshots `pendingProcessing` and goes to `idle` but does not mirror full `stopRecording()` (processing UI, trade-context window, etc.). Decide product behavior before changing.

2. **IPC payload limits:** Optional caps / validation on renderer-supplied payloads.

3. **Split `src/main/index.ts`:** Large file; splitting by concern would help maintainability.

4. **Dependency / security audit:** `npm audit` upstream noise; dedicated pass if required.

5. **Automated tests:** No `npm test` yet; good candidates: pipeline helpers, path logic.

6. **In-app microphone device picker:** Diagnostics exist; explicit device selection in Settings still deferred.

## Conventions

- Prefer matching existing patterns in nearby files (IPC naming `channel:verb`, `contextIsolation`, preload bridges).
- Avoid drive-by refactors unrelated to the task.
- User rule: Gradle builds use `--scan` — **not applicable** here (Node/Electron).

## Useful paths

| Area | Path |
|------|------|
| App entry / lifecycle | `src/main/index.ts` |
| Feedback + trade pipeline | `src/main/pipeline.ts`, `src/main/trade-pipeline.ts` |
| Mic diagnostics types | `src/shared/mic-diagnostics.ts` |
| Config | `src/main/config.ts` |
| Windows release CI | `.github/workflows/release-windows.yml` |
| Product doc | `README.md`, `snipalot_PRD.md` |
