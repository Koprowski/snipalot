# Installation Guide: Snipalot + Gemini CLI on Windows

**Mirror of [GitHub Issue #2](https://github.com/Koprowski/snipalot/issues/2).**  
When the download URL changes, update this file and paste its body into the issue (or edit the issue on GitHub).

**Current installer (latest):** [Snipalot-1.0.6-setup.exe](https://github.com/Koprowski/snipalot/releases/download/v1.0.6/Snipalot-1.0.6-setup.exe) — see [Releases](https://github.com/Koprowski/snipalot/releases).

**Before reinstalling:** quit Snipalot from the **system tray** (right-click tray icon → **Quit Snipalot**). The launcher **X** does not exit the app.

---

## What this is

Snipalot is a Windows screen-recording tool with a **Trade mode** built for meme coin traders. You record your session while narrating your trades out loud. When you stop, it automatically transcribes the audio, sends the transcript to an AI model, and generates a structured trade log (CSV + Markdown) — no manual steps.

---

## Step 1 — Download and install Snipalot

**[⬇ Download Snipalot-1.0.6-setup.exe](https://github.com/Koprowski/snipalot/releases/download/v1.0.6/Snipalot-1.0.6-setup.exe)**

1. Click the link above to download the installer
2. Once downloaded, open your **Downloads** folder and double-click **Snipalot-1.0.6-setup.exe**
3. If Windows shows a blue "Windows protected your PC" warning, click **More info** → **Run anyway**
4. Click through the installer (Next → Install → Finish)
5. Snipalot now appears in your **Start menu** — press the Windows key and type **Snipalot** to launch it any time

> No Node.js, Git, or command line needed.

---

## Step 2 — Get a free AI API key

Snipalot needs an API key to automatically analyze your trades. Pick whichever option suits you:

### Option A — Google Gemini (recommended, completely free)

1. Go to **https://aistudio.google.com/apikey** and sign in with any Google account
2. Click **Create API key** → **Create API key in new project**
3. Copy the key — it starts with `AIza`

Free tier: 1,500 requests per day, no credit card needed.

### Option B — OpenRouter (free tier, access to many models)

1. Go to **https://openrouter.ai/keys** and create a free account
2. Click **Create Key**, give it a name, copy the key — it starts with `sk-or-`

Free tier includes Gemini Flash and Llama 3.3 70B at no cost.

---

## Step 3 — Add your API key to Snipalot

1. Launch Snipalot from the Start menu
2. Click the **⚙ gear icon** in the top-right of the launcher window
3. Scroll down to **Trade Mode**
4. Paste your key into the matching field:
   - Google key (`AIza…`) → **Gemini API Key**
   - OpenRouter key (`sk-or-…`) → **OpenRouter / OpenAI API Key**
5. Click **Save**

---

## Step 4 — Record your first trade session

1. Launch Snipalot from the Start menu
2. Click the **violet Trade button** in the launcher (or press `Ctrl+Shift+T`)
3. Drag to select the region of your screen to record (your Padre / trading window)
4. Trade normally and narrate out loud: *"Going into PEPE at 80k market cap, target 150k…"*
5. Press `Ctrl+Shift+M` to drop a marker at any key moment
6. Click **Stop** in the floating HUD when done

Snipalot then automatically:

- Converts the recording to MP4
- Transcribes your voice with Whisper (runs locally, nothing is uploaded)
- Sends the transcript to your AI model
- Writes `trade_log.csv` + `trade_log.md` + `adherence_report.md` to your session folder

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
  trade_log.csv          ← open this in Excel
  trade_log.md
  adherence_report.md
  transcript.txt
  mic_diagnostics.json     ← which microphone was used (for troubleshooting audio)
```

---

## Optional — add your MockApe / Padre trade data

Export your actual trades from MockApe or Padre as JSON and drop the file into the session folder named `mockape.json` before the recording stops. Snipalot will add real entry/exit market caps, P&L in SOL, and win/loss columns to the CSV automatically.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Windows shows "Windows protected your PC" | Click **More info** → **Run anyway** — appears because the installer isn't code-signed |
| No `trade_log.csv` after recording | Open the session folder — if `extraction_response.json` is missing, the API call failed. Double-check your key in Settings → Trade Mode |
| Recording has no audio | Check the microphone icon in the HUD. In Windows **Settings → System → Sound → Input**, set the correct default microphone. Open **`mic_diagnostics.json`** in the session folder to see which device Snipalot captured and any errors |
| Snipalot doesn't appear in Start menu after install | Re-run the installer, or search for Snipalot in `C:\Users\YourName\AppData\Local\Programs\` |

---

*[Snipalot on GitHub](https://github.com/Koprowski/snipalot)*
