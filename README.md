# Snipalot

## Download for Windows

**Latest installer:** [Download Snipalot-1.0.13-setup.exe](https://github.com/Koprowski/snipalot/releases/download/v1.0.13/Snipalot-1.0.13-setup.exe)

Run the installer, then open Snipalot from the Start menu. If Windows SmartScreen says the app is unrecognized, choose **More info** then **Run anyway**. This is the light installer: Settings includes a setup checklist that can download Whisper for local transcription and install/sign in to Gemini CLI for trade extraction.

A Windows desktop tool for giving AI feedback on your screen — by talking, annotating, and capturing. Three capture modes cover everything from a quick screenshot to a long trading session.

---

## What it does

### Record mode
Hotkey-triggered screen recordings with live annotation. Talk through your feedback while drawing highlights and shapes on screen in real time. When you stop, Snipalot:

- Converts the recording to MP4 and an animated GIF
- Transcribes your audio locally using Whisper (no cloud, no API key)
- Packages the transcript, annotated snapshots, and a numbered annotation list into a single LLM-ready prompt
- Copies the prompt to your clipboard automatically

Paste into Claude Code, Gemini CLI, Cursor, or any other LLM interface and you're done.

### Screenshot + Annotator mode
One-shot region capture that opens a full annotation workspace. Draw on the screenshot, leave notes, then copy a structured feedback prompt or save the annotated image. No recording needed.

The annotation workspace includes:

- **Highlight** — semi-transparent fill rect (adjustable opacity)
- **Shapes** — rect, circle, oval, line, arrow
- **Doodle** — freehand pen
- **Text** — click to place; double-click to edit. When a text annotation is selected, a contextual style bar appears in the toolbar with font family, font size, background fill (with transparent/checker toggle), and border color (with none/checker toggle)
- **Select** — drag to reposition, corner handles to resize, click a swatch to recolor
- **Overlay images** — paste a second screenshot on top, resize, crop, then annotate across both
- **Undo/Redo** — full history (Ctrl+Z / Ctrl+Y)
- **Rotate** — 90° left/right; all annotations rotate with the image
- **Feedback prompt** — generated automatically from your annotations and notes; editable inline or in a full-screen overlay; copies to clipboard

Saved output (in your configured output folder): annotated PNG with legend + `prompt.md`.

### Trade mode
Designed for traders who narrate during live sessions. Records one long session (up to ~2 hours), then runs a post-session extraction pipeline:

1. **Record** — one continuous recording; the trader narrates entries, targets, rationale, exits, and post-trade commentary naturally
2. **Mark trades** — optional `Ctrl+Shift+X` hotkey (default; rebindable in Settings) stamps timestamps and screenshots as anchor points for the LLM (works without markers, they just improve accuracy)
3. **Add MockApe data** — after stopping, a data-entry window lets you paste your MockApe JSON or CSV export; Snipalot matches trades to the recording window and attaches entry/exit market caps and PnL
4. **LLM extraction** — Snipalot writes `prompt.txt` containing the full transcript, trade markers, screenshots, and MockApe data, formatted for a structured extraction pass
5. **Paste and receive** — Snipalot can run Gemini CLI automatically; if manual review is needed, paste the JSON response into the response window or save it as `Inputs/extraction_response.json`
6. **Auto-output** — Snipalot detects the response file and immediately generates:
   - `trade_log.xlsx` — formatted workbook with one row per trade, concrete timeline columns, wrapped rationale/excerpt fields, rounded SOL/PnL/market-cap fields, and inferred/actual entry/exit times
   - `trade_log.md` — human-readable version with the session GIF at the top and per-trade screenshots embedded
   - `Inputs/adherence_report.md` — session-level aggregate stats and review notes

---

## Launcher

The launcher is a small always-available control panel that lives in your taskbar or system tray.

- **Record** (red) — start a region-select recording session
- **Screenshot** (blue) — capture a region and open the annotation workspace
- **Trade** (purple) — start a region-select trade recording session
- **Copy Last Prompt** — copies the most recent generated prompt to clipboard without reopening anything
- **Pin** — keeps the launcher on top of other windows
- **Settings** — output folder, hotkeys, capture mode, countdown duration
- **Settings → Trade Mode → Setup checklist** — install/check Whisper, Node/npm, Gemini CLI, and Google sign-in
- **X** — exits Snipalot. Minimize keeps the launcher available from the taskbar.

---

## HUD

During recording, a compact HUD overlays your screen with:

- Live recording timer
- Pause / Resume
- Snapshot (saves an annotated still mid-recording; `Ctrl+Shift+P`)
- Annotate (draws annotation overlays directly on the live recording)
- Stop
- Discard (cancels and deletes the recording)
- Trade marker count badge (Trade mode only)

---

## Hotkeys (defaults, all rebindable in Settings)

| Action | Default |
|--------|---------|
| Start/stop recording | `Ctrl+Shift+S` |
| Start / stop trade session | `Ctrl+Shift+T` (toggle from idle or while trading) |
| Mark trade event | `Ctrl+Shift+X` (only while a trade recording is active) |
| Mid-session snapshot | `Ctrl+Shift+P` |
| Annotate (during recording) | `Ctrl+Shift+A` |
| Pause / resume | `Ctrl+Shift+B` |
| Annotator save | `Ctrl+S` |
| Annotator undo | `Ctrl+Z` |

---

## Output folder layout

All output lands in the folder configured in Settings (default: `C:\Users\<you>\Videos\Snipalot`).

```
{stamp} feedback/         ← Record mode session
  recording.mp4
  {stamp} feedback.gif
  transcript.txt
  prompt.txt
  mic_diagnostics.json    ← which mic was captured (labels, device ids, errors)
  snapshots/

{stamp} screenshot/       ← Screenshot mode session
  snapshot.png
  prompt.md

{stamp} trade/            ← Trade mode session
  {stamp} trade.gif
  prompt.txt              ← paste-ready trade extraction prompt
  transcript.txt
  trade_log.xlsx          ← formatted trade workbook
  trade_log.md
  Inputs/
    annotations.json
    mic_diagnostics.json
    markers.json
    mockape.json             (optional MockApe/Padre export)
    extraction_response.json (manual LLM response, if needed)
    adherence_report.md
    trade-screenshots/
```

---

## Installation (Windows — pre-built)

**End users** (no Node.js or Git required):

1. **Download the installer** (current release **v1.0.9**):
   - **Direct:** [Snipalot-1.0.9-setup.exe](https://github.com/Koprowski/snipalot/releases/download/v1.0.9/Snipalot-1.0.9-setup.exe)
   - Or open **[Releases](https://github.com/Koprowski/snipalot/releases)** and grab the latest **`Snipalot-*-setup.exe`** (NSIS installer, Windows x64).
2. Run the installer. If SmartScreen warns that the app is unrecognized, use **More info** → **Run anyway** (the binary is not code-signed yet).

**Upgrading or reinstalling:** close Snipalot before running a new installer. The launcher **X** exits the app; the tray menu also has **Quit Snipalot**. If the setup still says the app cannot be closed, click **Retry** after quitting (the installer retries several times).

The Windows installer bundles the local Whisper transcription engine and the `ggml-base.en.bin` model, so recording/transcription works without a separate post-install download.

**Trade mode + Gemini / API keys:** step-by-step guide in **[`docs/installation-guide-issue-2.md`](./docs/installation-guide-issue-2.md)** (same content as **[Issue #2](https://github.com/Koprowski/snipalot/issues/2)**; the doc in `docs/` carries the current download URL). Current Gemini CLI default is `gemini-3.1-pro-preview`; Settings can fetch available Gemini CLI models on the target machine.

**No audio after recording?** Each session folder can include **`mic_diagnostics.json`** (which microphone was used and any capture errors). See the troubleshooting table in the install guide above.

---

## Installation (dev)

Requires Node.js 20+ and Windows 10/11.

```
git clone https://github.com/Koprowski/snipalot.git
cd snipalot
npm install
npm run fetch-resources
npm run dev
```

Whisper and FFmpeg are bundled under `resources/bin/` after `npm run fetch-resources` — no separate installation needed.

### Production / installer build (from source)

On **Windows**, from the repo root:

```
npm install
npm run package
```

This runs `electron-builder` and writes the NSIS setup (and related artifacts) under **`release/`** — see `electron-builder.yml`. For a portable `.exe` only: `npm run package:portable`.

> Building the Windows installer on Linux produces AppImage/Snap only, not the `.exe`.

---

## Status

Actively developed. Record, Screenshot/Annotator, and Trade modes are functional on Windows. Trade mode now writes formatted XLSX output and keeps raw trade inputs under `Inputs/`.

Deferred:
- Window-picker capture mode — current options are region (drag to select) and fullscreen; per-window capture is marked "coming soon" in Settings

---

## License

MIT. See [`LICENSE`](./LICENSE).
