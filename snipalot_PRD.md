# Screen Feedback Tool — PRD

**Author:** Jason Koprowski
**Date:** 2026-04-16
**Status:** Draft
**Repo:** TBD (new standalone repo)

---

## Problem

Providing visual feedback on software currently requires multiple disconnected tools and manual steps:

1. **Snipping Tool** — record the screen
2. **Snagit** (or similar) — annotate screenshots with highlights and callouts
3. **Screenshot Annotator** (custom HTML tool) — number annotations and capture comments
4. **feedback-mp4 script** — transcribe audio, convert to GIF, generate LLM prompt
5. **Manual clipboard workflow** — copy prompt, paste into Claude Code

Each tool handles one piece. Switching between them breaks flow, and the outputs don't automatically connect. A 2-minute feedback session currently requires 5+ minutes of post-processing.

## Vision

A single tool that replaces all five steps. Press a hotkey to start recording. Talk through observations while drawing numbered annotations on screen in real time. Press the hotkey again to stop. The tool automatically transcribes, converts, and generates an LLM-ready prompt. Total post-processing time: zero.

## Core User Flow

1. **Launch** — tool starts minimized to system tray
2. **Start recording** — global hotkey (default `Ctrl+Shift+S`; rebindable) begins screen capture with audio
3. **Annotate while recording** — hotkey (default `Ctrl+Shift+A`; rebindable) enters annotation mode:
   - Click and drag to draw a numbered rectangle on screen
   - Number auto-increments (1, 2, 3...)
   - Annotation is visible in the recording itself (baked into the capture)
   - Press `Escape` to exit annotation mode and resume normal mouse interaction
4. **Clear annotations** — hotkey (e.g., `Ctrl+Shift+C`) clears all visible annotations from screen
   - Numbering continues from where it left off (annotations 1-3 cleared, next one is #4)
   - Useful when navigating to a new page/screen
5. **Stop recording** — same hotkey as start stops capture
6. **Auto-process** — tool automatically:
   - Saves MP4 to configured output folder
   - Runs Whisper transcription (timestamped SRT → clean text)
   - Converts to timestamped GIF
   - Generates LLM prompt with file paths
   - Copies prompt to clipboard
   - Shows system notification: "Feedback ready. Prompt copied."
7. **Paste and go** — user pastes prompt into Claude Code / any LLM CLI

## Annotation Features

### MVP (v1)

| Feature | Hotkey | Behavior |
|---|---|---|
| Numbered rectangle | Annotate hotkey (default `Ctrl+Shift+A`) then click+drag | Red rectangle with white number badge (top-left corner) |
| Clear annotations | `Ctrl+Shift+C` | Remove all visible annotations, keep numbering sequence |
| Undo last | `Ctrl+Z` (in annotation mode) | Remove the most recent annotation |

### Future (v2+)

| Feature | Description |
|---|---|
| Arrow | Draw an arrow pointing at something |
| Freehand circle | Circle/highlight an area |
| Text label | Type a short label directly on screen |
| Color options | Switch annotation color (red, blue, green) |
| Annotation log | Side panel showing all annotations with timestamps and any typed notes |
| Pause/resume | Pause recording without stopping |
| Region select | Record only a selected region instead of full screen |

## Technical Architecture

### Option A: Electron app (recommended for MVP)

**Pros:** Cross-platform, native screen capture API, transparent overlay window, system tray support, can bundle ffmpeg and Whisper.

**Cons:** Heavier install (~100MB+), Electron overhead.

**Architecture:**
```
┌─────────────────────────────────────────┐
│  Transparent always-on-top window       │
│  (annotation canvas overlay)            │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  User's screen content          │    │
│  │  (captured by desktopCapturer)  │    │
│  │                                 │    │
│  │    ┌───┐                        │    │
│  │    │ 1 │ ← annotation           │    │
│  │    └───┘                        │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
         │
         ▼
    MediaRecorder API
         │
         ▼
    MP4 file → Whisper → transcript.txt
             → ffmpeg  → recording.gif
             → prompt  → clipboard
```

**Key implementation details:**
- `desktopCapturer` API captures the screen INCLUDING the transparent overlay window, so annotations are baked into the recording automatically
- Overlay window: transparent, click-through by default, switches to interactive when annotation mode is active
- Global hotkeys via `globalShortcut` module
- System tray icon with start/stop/settings menu
- Post-processing calls ffmpeg and Whisper as child processes (bundled or found in PATH)

### Option B: Python + transparent tkinter/PyQt overlay

**Pros:** Lighter, can reuse existing Whisper Python install, simpler packaging.

**Cons:** Transparent overlays are finicky on Windows with tkinter. PyQt is more reliable but adds dependency weight. Screen capture requires `mss` or `pyautogui` + separate audio capture.

### Option C: AutoHotkey + OBS Studio plugin

**Pros:** Leverages OBS (professional screen capture), AHK handles global hotkeys natively on Windows.

**Cons:** Requires OBS installed separately, annotation overlay would need a browser source or custom plugin, tight coupling between two tools.

**Recommendation:** Option A (Electron) for the cleanest UX. The overlay-baked-into-capture behavior is the killer feature and Electron's desktopCapturer does it natively.

## File Output Structure

```
E:\Video Screencasts\
  20260416.1530 feedback\
    transcript.txt              ← timestamped: [0:15 - 0:22] Annotation #1: this button...
    Screen Recording ....gif    ← GIF with annotations visible in frames
    Screen Recording ....mp4    ← kept in source folder per retention policy
  annotations\
    annotations.json            ← structured log of all annotations with timestamps
```

### annotations.json schema

```json
{
  "sessionId": "20260416.1530",
  "annotations": [
    {
      "number": 1,
      "timestamp": 15.3,
      "rect": { "x": 120, "y": 340, "width": 200, "height": 50 },
      "screen": "mobile-canvas-view",
      "cleared": false
    },
    {
      "number": 2,
      "timestamp": 28.7,
      "rect": { "x": 400, "y": 100, "width": 150, "height": 80 },
      "screen": "mobile-canvas-view",
      "cleared": true,
      "clearedAt": 45.0
    }
  ]
}
```

This gives the LLM both the spoken transcript AND the structured annotation data, so it can cross-reference "annotation #1 at 0:15" with the exact screen region that was highlighted.

## Integration with Existing Tools

### feedback-mp4 script
The post-processing pipeline (Whisper + ffmpeg + prompt generation) is already built and tested. The new tool wraps it:
- Calls the same `process-feedback.ps1` script after recording stops
- Or embeds the pipeline directly (Whisper via Python subprocess, ffmpeg via child process)

### Screenshot Annotator (existing HTML tool)
The annotation UX borrows from the existing tool's numbered-highlight pattern. The key difference: annotations happen in real-time during recording instead of after-the-fact on a static screenshot.

### Claude Code /feedback-mp4 skill
The generated prompt is identical to what the current script produces. The `/feedback-mp4` slash command in Claude Code works unchanged.

## Configuration

Stored in `~/.screen-feedback-tool.json`:

```json
{
  "outputDir": "E:\\Video Screencasts",
  "whisperExe": "E:\\Tools\\whisper-env\\Scripts\\whisper.exe",
  "whisperModel": "base",
  "mp4Retention": "keep-latest",
  "hotkeys": {
    "startStop": "Ctrl+Shift+S",
    "annotate": "Ctrl+Shift+A",
    "clear": "Ctrl+Shift+C",
    "undo": "Ctrl+Z"
  },
  "annotation": {
    "color": "#EF4444",
    "badgeColor": "#FFFFFF",
    "strokeWidth": 3,
    "fontSize": 16
  }
}
```

## MVP Scope

### In scope
- Screen recording with audio (full screen)
- Numbered rectangle annotations during recording
- Clear annotations with continued numbering
- Auto-processing on stop (Whisper + ffmpeg + prompt)
- System tray with start/stop
- Global hotkeys
- Config file for paths and hotkeys
- Windows support

### Out of scope (v2+)
- Region-select recording
- Arrows, circles, freehand drawing, text labels
- Color switching
- Annotation side panel / log view
- Pause/resume recording
- Mac/Linux support
- Built-in LLM integration (sending prompt directly to Claude API)
- Video editor / trim before export

## Success Criteria

1. End-to-end flow from hotkey-start to clipboard-prompt takes under 30 seconds for a 2-minute recording
2. Annotations are visible in both the exported GIF and extracted PNG frames
3. No manual file management or copy-paste required between recording and LLM prompt
4. Works reliably on Windows 11 with Chrome/Edge as the target app being recorded

## Open Questions

1. **Annotation capture method**: Does Electron's `desktopCapturer` reliably capture a transparent overlay window on Windows 11? Need to prototype this early, as it's the core technical risk. Fallback: composite annotations onto the video in post-processing using ffmpeg drawbox/drawtext filters (less elegant but guaranteed to work).

2. **Audio source**: Record system audio, microphone, or both? Microphone-only is simpler and sufficient for spoken feedback. System audio would capture app sounds but adds complexity.

3. **Whisper bundling**: Bundle Whisper inside the Electron app (larger install, no Python dependency) or require external Whisper installation (lighter, reuses existing install)? Recommendation: detect existing installation first, offer to download if missing.

4. **Installer**: Ship as a portable .exe (no install), an NSIS installer, or via winget? Portable is simplest for MVP.
