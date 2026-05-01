# Dependency Check Issue Log

Persistent tracker for the recurring Settings checklist issue where Node/npm is reported missing even when the user has installed Node.js and Gemini CLI works.

## Current symptom

- Settings -> Trade Mode -> Setup checklist shows:
  - OK - Whisper
  - Missing - Node/npm: npm check failed. Install Node.js LTS first.
  - OK - Gemini CLI
- This is confusing because the only current use for Node/npm in the installed app is to install or update Gemini CLI. Once Gemini CLI is already present and runnable, Node/npm should not appear as a blocking missing dependency.

## Evidence

- User screenshot on 2026-05-01 still showed Node/npm as missing while Gemini CLI `0.40.1` was OK.
- Local terminal on the same PC can run:
  - `C:\Program Files\nodejs\npm.cmd --version`
  - observed version: `11.12.1`
- Installed app log before the latest fix showed the old broken command quoting:
  - `'\\"C:\Program Files\nodejs\npm.cmd\\"' is not recognized as an internal or external command`
- Current source had already been changed in v1.0.19 to use:
  - `cmd.exe /d /c call "C:\Program Files\nodejs\npm.cmd" --version`
- Because the installed app still logged the old quote shape, possible causes are:
  - user was still running an older installed build after upgrade
  - installer did not replace the running build
  - app was launched from an older shortcut/path

## Changes made

### v1.0.19

- Changed Windows npm probe to launch `npm.cmd` through `cmd.exe /d /c call ...` with cmd-safe quoting.
- Added npm probe stderr/stdout tails to Settings dependency logs.

### v1.0.22

- Dependency check now logs `appVersion` so support logs prove which installed build produced the result.
- Node/npm is no longer treated as missing when Gemini CLI is already installed and runnable.
- In that state, Settings reports Node/npm as OK/optional with this meaning:
  - Gemini CLI is working.
  - Node/npm is only needed if Snipalot needs to install or update Gemini CLI.

## Desired behavior

- Fresh machine with no Node and no Gemini CLI:
  - Node/npm: Missing
  - Gemini CLI: Missing
  - Install Node.js should be offered.
- Machine with Node but no Gemini CLI:
  - Node/npm: OK
  - Gemini CLI: Missing
  - Install Gemini CLI should be offered.
- Machine with Gemini CLI already installed and working, even if npm probe fails:
  - Node/npm: OK/optional
  - Gemini CLI: OK
  - No blocking Missing Node/npm warning.

## Next checks if this reappears

1. Open the support log and verify the `settings dependency check` line includes `appVersion`.
2. Confirm the app is running from the expected install path:
   - `%LOCALAPPDATA%\Programs\Snipalot\Snipalot.exe`
3. Confirm the Start Menu shortcut target points to that same path.
4. If `geminiOk` is true and Node/npm is still displayed as missing, inspect Settings renderer formatting rather than npm probing.
5. If `appVersion` is older than the current release, the installer/shortcut path is stale rather than the dependency check logic.
