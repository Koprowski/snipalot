# Recording Shortcuts Persistent Issue Log

## Tracking

- Recommended source of truth: GitHub issue (single thread for user-visible impact + cross-session history).
- Local mirror: this file for fast in-repo handoff and copy/paste continuity.

## Current Symptom

- Triggering record/trade via hotkeys can hide/close visible UI without showing active recording/HUD.
- User expectation: overlay/HUD appears immediately and session starts reliably.

## Investigation Log

### Pass 1 - Log Review (2026-04-30)

- **What was tested**
  - Reviewed `spike-output/snipalot.log` around shortcut-triggered start.
- **Key evidence**
  - `state selecting → recording region confirmed`
  - `recorder queued start; recorder renderer not ready yet`
  - No subsequent `renderer signaled ready` and no `recorder:state started`.
  - Session then appears to stall in an invisible/failed-start state.
- **Result**
  - Start dispatch can wait indefinitely on recorder-ready handshake.
- **Likelihood**
  - 95/100 that missing/late recorder-ready signal is the primary cause for this failure mode.

### Pass 2 - Mitigation Implemented (2026-04-30)

- **What changed**
  - Added recorder-start fallback dispatch on recorder `did-finish-load`.
  - Added 5s readiness timeout to abort safely back to idle instead of hanging.
  - Added user notification when recorder initialization times out.
- **Result expected**
  - Recording should either start or fail loudly with recovery to idle (never silent hang).

### Pass 3 - Build/Static Verification (2026-04-30)

- **What was tested**
  - Ran `npm run build` after the recorder fail-safe changes were present.
  - Re-read the start path around `dispatchRecorderStart`, `recorder:ready`, and the `did-finish-load` fallback.
- **Observed log lines**
  - No runtime recording attempt was performed in this pass.
- **Result**
  - TypeScript build passes.
  - Static flow now has three outcomes after region confirmation:
    - immediate `recorder:start` when renderer is already ready,
    - queued `recorder:start` flushed by `recorder:ready` or `did-finish-load`,
    - 5s timeout returning to idle with a user-facing notification.
- **Updated likelihoods**
  - Missing/late `recorder:ready` remains the leading suspected cause of the original silent hang.
  - Hands-on validation is still required because Electron global shortcuts and Windows capture prompts are runtime/desktop-sensitive.
- **Next action**
  - Perform an interactive pass for `Ctrl+Shift+S` and `Ctrl+Shift+T`, then paste exact `snipalot.log` lines here.

### Pass 4 - Root Cause Found From Runtime Logs (2026-04-30)

- **What was tested**
  - Reviewed `spike-output/snipalot.log` after failed Record/Trade button attempts.
  - Inspected compiled recorder renderer output in `dist/recorder/recorder.js`.
- **Observed log lines**
  - `recorder window finished load`
  - `recorder queued start; recorder renderer not ready yet`
  - `recorder renderer readiness timeout; aborting recording start`
  - No `renderer signaled ready`, no recorder renderer `mainLog`, and no `recorder:state started`.
- **Result**
  - The hidden recorder window loaded, but the recorder renderer script did not finish booting.
  - Root cause: `src/recorder/recorder.ts` used a type-only import from `../shared/mic-diagnostics`, which made TypeScript emit CommonJS module boilerplate (`Object.defineProperty(exports, ...)`) into `dist/recorder/recorder.js`. Because `recorder.html` loads that file as a normal browser script with `nodeIntegration:false`, `exports` is undefined and the script can fail before calling `window.snipalotRecorder.reportReady()`.
  - Fix applied: replaced the type-only import with local renderer-only interfaces so the compiled recorder script has no `exports`/`require` references. Added main-process forwarding for recorder `console-message` and `preload-error` events so future renderer bootstrap errors land in `snipalot.log`.
- **Updated likelihoods**
  - 95/100 that the CommonJS `exports` bootstrap failure caused the missing HUD / never-started recorder symptom.
- **Next action**
  - Restart Snipalot from the rebuilt app, try Record and Trade again, and confirm logs show `renderer signaled ready`, `recorder ready`, `recording started`, then `recorder state started`.

## Open Checks

- Verify hotkey path in runtime:
  - `Ctrl+Shift+S` from idle -> start HUD/recording.
  - `Ctrl+Shift+T` from idle -> start trade recording/HUD.
- Confirm log now contains either:
  - `renderer signaled ready` and `recorder state started`, or
  - explicit timeout + safe idle recovery.
- If still failing, capture next pass with exact log lines and timestamp.

## Next Log Entry Template

- **Pass N**
  - **What was tested**:
  - **Observed log lines**:
  - **Result**:
  - **Updated likelihoods**:
  - **Next action**:
