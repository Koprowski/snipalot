/**
 * Settings renderer — load config, let the user edit output dir,
 * display hotkeys, and save back via IPC.
 */

const api = window.snipalotSettings;

const dirInput = document.getElementById('input-dir') as HTMLInputElement;
const btnBrowse = document.getElementById('btn-browse') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement;
const btnClose = document.getElementById('btn-close') as HTMLButtonElement;
const settingsStatusEl = document.getElementById('status') as HTMLElement;
const hotkeysBody = document.getElementById('hotkeys-body') as HTMLTableSectionElement;
const firstRunBanner = document.getElementById('first-run-banner') as HTMLElement;

// ─── hotkey label map ──────────────────────────────────────────────────

const HOTKEY_LABELS: Record<string, string> = {
  startStop: 'Start / Stop recording',
  annotate: 'Enter annotation mode',
  clear: 'Clear annotations',
  undo: 'Undo annotation',
  pauseResume: 'Pause / Resume',
  toggleOutline: 'Toggle region outline',
};

// ─── init ──────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const config = await api.getConfig();
  api.log('settings', 'loaded config', config);

  // Output dir
  dirInput.value = config.outputDir ?? '';

  // First-run banner
  if (config.firstRun) {
    firstRunBanner.style.display = 'block';
  }

  // Hotkeys table
  hotkeysBody.innerHTML = '';
  const hk = (config.hotkeys ?? {}) as unknown as Record<string, string>;
  for (const [key, label] of Object.entries(HOTKEY_LABELS)) {
    const combo: string = hk[key] ?? '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${label}</td>
      <td><span class="kbd">${escHtml(combo)}</span></td>
    `;
    hotkeysBody.appendChild(tr);
  }
}

// ─── browse ────────────────────────────────────────────────────────────

btnBrowse.addEventListener('click', async () => {
  const picked = await api.pickFolder();
  if (picked) {
    dirInput.value = picked;
    setStatus('');
  }
});

// ─── save ──────────────────────────────────────────────────────────────

btnSave.addEventListener('click', async () => {
  const dir = dirInput.value.trim();
  if (!dir) {
    setStatus('Output folder cannot be empty.', true);
    dirInput.focus();
    return;
  }
  btnSave.disabled = true;
  setStatus('Saving…');
  try {
    await api.save({ outputDir: dir, firstRun: false });
    firstRunBanner.style.display = 'none';
    // Close immediately — no need for user to also hit X.
    api.close();
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, true);
  } finally {
    btnSave.disabled = false;
  }
});

// ─── cancel / close ────────────────────────────────────────────────────

btnCancel.addEventListener('click', () => api.close());
btnClose.addEventListener('click', () => api.close());

// ─── helpers ───────────────────────────────────────────────────────────

function setStatus(msg: string, isError = false): void {
  settingsStatusEl.textContent = msg;
  settingsStatusEl.className = 'status' + (isError ? ' err' : msg ? ' ok' : '');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── boot ──────────────────────────────────────────────────────────────

init().catch((err) => {
  api.log('settings', 'init error', String(err));
  setStatus('Failed to load settings.', true);
});
