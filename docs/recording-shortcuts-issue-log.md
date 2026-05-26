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

### Pass 5 - State Hotkey Re-registration Loop (2026-05-24)

- **What was tested**
  - Reviewed a runtime log where pressing `Ctrl+Shift+S` caused rapid idle/selecting toggles.
- **Observed log lines**
  - `startStop fired {"appState":"selecting"}`
  - `selecting -> idle exitSelecting: Ctrl+Shift+S during selecting`
  - `register {"name":"startStop","combo":"Ctrl+Shift+S",...,"appState":"idle"}`
  - `startStop fired {"appState":"idle"}`
  - `idle -> selecting user toggle from idle`
  - The same pattern repeated in milliseconds.
- **Result**
  - Root cause: the state-changing global shortcut handler called into a state transition, and the state transition immediately ran `reloadGlobalHotkeys()`. That unregister/re-register cycle re-armed the same chord while the physical keys were still down, causing Electron to fire the shortcut again.
  - Fix applied: `Ctrl+Shift+S` (`startStop`) and `Ctrl+Shift+T` (`startTrade`) now enter a short rearm window after firing. During that window, `reloadGlobalHotkeys()` skips those state-changing shortcuts and registers them again after the guard expires.
- **Validation**
  - `npm run build`
  - `npm test`
- **Next action**
  - Hands-on runtime validation is still needed on Windows: press and release `Ctrl+Shift+S` once from idle, confirm exactly one `startStop fired` followed by a `skip register` with reason `state transition rearm window`, then confirm no repeated idle/selecting loop.

### Pass 6 - App Close After Loop Guard (2026-05-24)

- **What was tested**
  - Reviewed the `Ctrl+Shift+S` path after Pass 5 stopped the repeat loop but the app still closed instead of starting selection.
- **Result**
  - The repeat-loop guard was necessary but incomplete. `startStop` still called `handleToggleHotkey()` synchronously from inside Electron's `globalShortcut` callback. That path enters selection, and `setAppState()` calls `reloadGlobalHotkeys()`, which previously ran `globalShortcut.unregisterAll()` before Electron had returned from the active shortcut callback.
  - Fix applied: all registered global shortcut callbacks now run through a dispatch wrapper. If `reloadGlobalHotkeys()` is requested while a global shortcut callback is active, Snipalot queues the reload and runs it on the next event-loop tick after the callback exits.
  - The Pass 5 rearm guard remains in place, so the deferred reload skips `Ctrl+Shift+S` / `Ctrl+Shift+T` until the short rearm window expires.
- **Validation**
  - `npm run build`
  - `npm test`
- **Expected runtime evidence**
  - `startStop fired`
  - `reload queued until global shortcut callback exits`
  - `deferred reload running after global shortcut dispatch`
  - `skip register` with reason `state transition rearm window`
  - Region selection remains open; no `before-quit`, `will-quit`, or repeated idle/selecting loop follows.

### Pass 7 - Overlay Rebuild Race During Drawing (2026-05-26)

- **What was investigated**
  - User reported intermittent crashes/buggy behavior while dragging a recording region and while using the screenshot annotator.
  - Reviewed `%APPDATA%\Snipalot\logs\snipalot.log` and the main/overlay/annotator lifecycle code.
- **Observed evidence**
  - Current `1.1.0` region-selection attempt reached `region-confirmed`, `recording region confirmed`, `getDisplayMedia resolved`, and `MediaRecorder started`, so the latest recording path did not fail in the recorder backend.
  - The code rebuilt overlay windows immediately on every `display-added`, `display-removed`, and `display-metrics-changed` event. Windows can emit these in bursts during monitor wake/reconnect/DPI changes.
  - `rebuildOverlays()` cleared `overlayWindows` even when an overlay `close` event was prevented during selection, which could orphan transparent interactive overlay windows and make drag/select/annotation feel like it crashed or stopped responding.
- **Fix applied**
  - Display-change rebuilds are now debounced.
  - If a display change arrives during region selection, Snipalot cleanly cancels selection before rebuilding overlays.
  - Overlay rebuilds are deferred during recording/processing so the active drawing surface is not torn down mid-session.
  - Overlay renderer `console-message`, `did-fail-load`, `preload-error`, and `render-process-gone` events now log to `snipalot.log`.
- **Validation**
  - `npm run build`
  - `npm test`
- **Next action**
  - Runtime validation on Windows: start Record/Screenshot region selection, drag regions on each display, trigger monitor wake/reconnect if possible, and confirm either stable selection or a clean `display change cancelled active selection before overlay rebuild` log line with no orphan overlays.

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
