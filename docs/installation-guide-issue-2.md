# Installation Guide: Snipalot + Gemini CLI on Windows

**Mirror of [GitHub Issue #2](https://github.com/Koprowski/snipalot/issues/2).**  
When the download URL changes, update this file and paste its body into the issue (or edit the issue on GitHub).

**Current installer (latest):** [Snipalot-1.0.19-setup.exe](https://github.com/Koprowski/snipalot/releases/download/v1.0.19/Snipalot-1.0.19-setup.exe) — see [Releases](https://github.com/Koprowski/snipalot/releases).

**Before reinstalling:** quit Snipalot first. The launcher **X** exits the app; the tray menu also has **Quit Snipalot**.

---

## What this is

Snipalot is a Windows screen-recording tool with a **Trade mode** built for meme coin traders. You record your session while narrating your trades out loud. When you stop, it automatically transcribes the audio, sends the transcript to an AI model, and generates a structured trade log (XLSX + Markdown) — no manual steps.

---

## Step 1 — Download and install Snipalot

**[⬇ Download Snipalot-1.0.19-setup.exe](https://github.com/Koprowski/snipalot/releases/download/v1.0.19/Snipalot-1.0.19-setup.exe)**

1. Click the link above to download the installer
2. Once downloaded, open your **Downloads** folder and double-click **Snipalot-1.0.19-setup.exe**
3. If Windows shows a blue "Windows protected your PC" warning, click **More info** → **Run anyway**
4. Click through the installer (Next → Install → Finish)
5. Snipalot now appears in your **Start menu** — press the Windows key and type **Snipalot** to launch it any time

> This is the light installer. Snipalot downloads Whisper and Gemini CLI from Settings after install instead of packing them into the setup EXE.

---

## Step 2 — Complete the setup checklist

1. Launch Snipalot from the Start menu
2. Click the **⚙ gear icon** in the launcher
3. Scroll to **Trade Mode → Setup checklist**
4. Click **Install Whisper** if Whisper is missing
5. Click **Check Dependencies** again and confirm Whisper is OK

---

## Step 3 — Set up Trade-mode AI

Snipalot can analyze trades with either Gemini CLI (recommended, no API key) or an OpenRouter/OpenAI-compatible API key.

### Option A — Gemini CLI (recommended, no API key)

1. Install Node.js 20+ from **https://nodejs.org/** if the setup checklist says Node/npm is missing
2. In **Settings → Trade Mode**, click **Install Gemini CLI** if Gemini CLI is missing
3. Keep **LLM backend** set to **Gemini CLI**
4. Click **Sign in with Google** and complete the browser login
5. Click **Test LLM Connection**, then **Save**

This uses free Gemini Code Assist quota. No Gemini API key is needed.

### Option B — OpenRouter (free tier, access to many models)

1. Go to **https://openrouter.ai/keys** and create a free account
2. Click **Create Key**, give it a name, copy the key — it starts with `sk-or-`

---

## Step 4 — Optional API-key fallback

1. Launch Snipalot from the Start menu
2. Click the **⚙ gear icon** in the top-right of the launcher window
3. Scroll down to **Trade Mode**
4. Change **LLM backend** to **API keys (OpenRouter/OpenAI-compatible)**
5. Paste your OpenRouter key (`sk-or-…`) into **OpenRouter / OpenAI API Key**
6. Pick or type a model, click **Test LLM Connection**, then **Save**

---

## Step 5 — Record your first trade session

1. Launch Snipalot from the Start menu
2. Click the **violet Trade button** in the launcher (or press `Ctrl+Shift+T`)
3. Drag to select the region of your screen to record (your Padre / trading window)
4. Trade normally and narrate out loud: *"Going into PEPE at 80k market cap, target 150k…"*
5. Press `Ctrl+Shift+X` to drop a marker at any key moment
6. Click **Stop** in the floating HUD when done

Snipalot then automatically:

- Converts the recording to MP4
- Transcribes your voice with Whisper (runs locally, nothing is uploaded)
- Sends the transcript to your AI model
- Writes `trade_log.xlsx` + `trade_log.md` to your session folder, with supporting review docs under `Inputs/`

Post-processing takes about 1–2 minutes for a 30-minute session.

---

## Where your files go

Open **File Explorer** and paste this into the address bar at the top:

```
%USERPROFILE%\Videos\Snipalot
```

Each session gets its own folder, e.g.:

```
Videos\Snipalot\20260429.1622 trade\
  20260429.1622 trade.gif
  prompt.txt
  transcript.txt
  trade_log.xlsx       ← open this in Excel
  trade_log.md         ← includes the GIF and trade screenshots
  Inputs\
    mic_diagnostics.json
    markers.json
    mockape.json
    extraction_response.json
    adherence_report.md
    trade-screenshots\
```

---

## Optional — add your MockApe / Padre trade data

Export your actual trades from MockApe or Padre as JSON and paste it into the trade data window after recording, or save it under the session folder as `Inputs/mockape.json`. Snipalot will add real entry/exit market caps, P&L in SOL, and win/loss columns to the XLSX automatically.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Windows shows "Windows protected your PC" | Click **More info** → **Run anyway** — appears because the installer isn't code-signed |
| No `trade_log.xlsx` after recording | Open the session folder. If `Inputs/extraction_response.json` is missing, the LLM extraction failed. In Settings → Trade Mode, click **Test LLM Connection** and follow any Gemini CLI install/sign-in guidance, or switch to API mode and verify the OpenRouter/OpenAI key |
| Recording has no audio | Check the microphone icon in the HUD. In Windows **Settings → System → Sound → Input**, set the correct default microphone. Open **`Inputs/mic_diagnostics.json`** in the session folder to see which device Snipalot captured and any errors |
| Snipalot doesn't appear in Start menu after install | Re-run the installer, or search for Snipalot in `C:\Users\YourName\AppData\Local\Programs\` |

---

*[Snipalot on GitHub](https://github.com/Koprowski/snipalot)*
