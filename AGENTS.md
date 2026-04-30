# Snipalot — agent handoff notes

Use this file to onboard LLMs or humans picking up work without full chat context.

## Repo snapshot

- **Stack:** Electron 30, TypeScript (strict), main process in `src/main/index.ts`, renderers under `src/*`, post-processing in `src/main/pipeline.ts` and `src/main/trade-pipeline.ts`.
- **Build:** `npm ci` then `npm run build`. Run app: `npm run dev`.
- **Windows installer:** `npm run package` (or `package:portable`) must run **on Windows** (or Windows CI). Linux builds produce AppImage/snap only; NSIS setup is configured in `electron-builder.yml` under `win:`.
- **End-user install (`.exe`):** Not in repo source — see **README → “Installation (Windows — pre-built)”**, **[GitHub Releases](https://github.com/Koprowski/snipalot/releases)**, and **[Issue #2](https://github.com/Koprowski/snipalot/issues/2)** for the full Gemini/trade walkthrough with download link.
- **No audio / wrong mic:** Each session folder includes **`mic_diagnostics.json`** (written when recording starts): granted vs denied, `getUserMedia` error string, active track label + `deviceId`, and enumerated `audioinput` devices. Main also logs a one-line `recorder` scope summary. Packaged app logs: **`spike-output/snipalot.log`** next to the process cwd (often under the install directory); search the PC for `snipalot.log` if unsure.
- **Config:** `%USERPROFILE%\.snipalot\config.json`; defaults in `src/main/config.ts`.

## Recently landed on `main` (high level)

- Frame picker export: `recording.mp4` resolved inside the session folder (not parent dir).
- README / launcher / logs aligned with actual hotkeys (e.g. trade marker default `Ctrl+Shift+M`, trade toggle `Ctrl+Shift+T`).
- Snapshot capture serialized in main to avoid overlapping `recorder:snap-result` listeners.
- Settings “pick output folder” dialog: safe parent window selection (no `parent!`).

## Open items — intentional deferrals

These came from code review; **not** implemented yet. Pick up as separate tasks if desired.

1. **Unexpected recorder stop** (`recorder:state` → `stopped` while `appState === 'recording'`): Main snapshots `pendingProcessing` and goes to `idle` but does not mirror full `stopRecording()` (processing UI, trade-context window, etc.). Decide product behavior (treat as stop + pipeline vs. discard vs. error UX) before changing.

2. **IPC payload limits:** Handlers accept large base64 / JSON from renderers without size caps. Optional hardening: max bytes, validation, user-facing errors.

3. **Split `src/main/index.ts`:** Very large single file; splitting by concern (windows, IPC, state machine) would help maintainability — invasive refactor.

4. **Dependency / security audit:** `npm audit` reports issues upstream; address in a dedicated pass if policy requires (may need `npm audit fix` / major bumps).

5. **Automated tests:** No `npm test` script today; pipeline path helpers and framepicker paths are good candidates for unit tests.

## Conventions

- Prefer matching existing patterns in nearby files (IPC naming `channel:verb`, `contextIsolation`, preload bridges).
- Avoid drive-by refactors unrelated to the task.
- User rule: Gradle builds use `--scan` — **not applicable** here (Node/Electron).

## Useful paths

| Area | Path |
|------|------|
| App entry / lifecycle | `src/main/index.ts` |
| Feedback + trade pipeline | `src/main/pipeline.ts`, `src/main/trade-pipeline.ts` |
| Config | `src/main/config.ts` |
| Product doc | `README.md`, `snipalot_PRD.md` |
