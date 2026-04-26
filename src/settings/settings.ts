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
  snapshot: 'Take snapshot (close chapter)',
  clear: 'Clear annotations',
  undo: 'Undo annotation',
  pauseResume: 'Pause / Resume',
  toggleOutline: 'Toggle region outline',
};

// Default combos shipped in the build. Source of truth lives in
// src/main/config.ts DEFAULT_CONFIG.hotkeys; this is a duplicate the
// Reset button can apply locally without an extra IPC roundtrip. Keep
// in sync if defaults ever change.
const DEFAULT_HOTKEYS: Record<string, string> = {
  startStop: 'Ctrl+Shift+S',
  annotate: 'Ctrl+Shift+A',
  snapshot: 'Ctrl+Shift+N',
  clear: 'Ctrl+Shift+C',
  undo: 'Ctrl+Z',
  pauseResume: 'Ctrl+Shift+P',
  toggleOutline: 'Ctrl+Shift+H',
};

// Working copy of bindings — mutated as the user clicks/captures, flushed
// to disk on Save. Initialized from config in init().
const editedHotkeys: Record<string, string> = {};

// ─── init ──────────────────────────────────────────────────────────────

// Working copy of the snapshot behavior. Mutates as the user clicks the
// radio; flushed on Save.
let editedSnapClearAfter = true;

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
  const hk = (config.hotkeys ?? {}) as unknown as Record<string, string>;
  for (const key of Object.keys(HOTKEY_LABELS)) {
    editedHotkeys[key] = hk[key] ?? DEFAULT_HOTKEYS[key] ?? '';
  }
  renderHotkeyRows();

  // Snapshot behavior radios. Default to clear-after if config is missing
  // the field (older configs predate this setting).
  const cfgSnap = (config as unknown as { snapshot?: { clearAnnotationsAfter?: boolean } }).snapshot;
  editedSnapClearAfter = cfgSnap?.clearAnnotationsAfter ?? true;
  const radioClear = document.getElementById('snap-clear') as HTMLInputElement;
  const radioKeep = document.getElementById('snap-keep') as HTMLInputElement;
  if (editedSnapClearAfter) radioClear.checked = true; else radioKeep.checked = true;
  radioClear.addEventListener('change', () => { if (radioClear.checked) editedSnapClearAfter = true; });
  radioKeep.addEventListener('change', () => { if (radioKeep.checked) editedSnapClearAfter = false; });
}

// ─── hotkey rendering + capture ────────────────────────────────────────

function renderHotkeyRows(): void {
  hotkeysBody.innerHTML = '';
  for (const [key, label] of Object.entries(HOTKEY_LABELS)) {
    const combo = editedHotkeys[key] ?? '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${label}</td>
      <td>
        <span class="hotkey-input" data-key="${key}" tabindex="0" role="button"
              aria-label="Click then press a key combination">${escHtml(combo)}</span>
      </td>
    `;
    hotkeysBody.appendChild(tr);
  }
  flagDuplicates();

  // Wire each input.
  for (const el of Array.from(hotkeysBody.querySelectorAll<HTMLElement>('.hotkey-input'))) {
    const key = el.dataset.key!;

    el.addEventListener('focus', () => {
      el.classList.add('capturing');
      el.textContent = 'Press keys…';
    });

    el.addEventListener('blur', () => {
      el.classList.remove('capturing');
      // Restore display; if user blurred without binding, show the saved one.
      el.textContent = editedHotkeys[key] || '—';
    });

    // Capture phase so we beat any default focus behavior.
    el.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Esc cancels the capture without changing anything.
      if (e.key === 'Escape') {
        el.blur();
        return;
      }
      // Backspace clears the binding (renders as the literal default's
      // placeholder dash; the field is required on save so we'll catch
      // an empty save before it lands).
      if (e.key === 'Backspace' || e.key === 'Delete') {
        editedHotkeys[key] = '';
        el.textContent = '—';
        flagDuplicates();
        return;
      }
      // Modifier-only presses (Shift alone, Ctrl alone) shouldn't commit.
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

      const parts: string[] = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (e.metaKey) parts.push('Meta');
      // Require at least one modifier so we don't bind 'a' globally.
      if (parts.length === 0) {
        setStatus('Combo must include Ctrl, Shift, or Alt.', true);
        return;
      }

      const main = normalizeKey(e.key, e.code);
      if (!main) return;
      parts.push(main);
      const combo = parts.join('+');

      editedHotkeys[key] = combo;
      el.textContent = combo;
      flagDuplicates();
      setStatus('');
      el.blur();
    });

    // Click → focus (clicks alone don't focus a span by default; tabindex helps).
    el.addEventListener('click', () => el.focus());
  }
}

/**
 * Convert a KeyboardEvent.key into our canonical combo segment. Maps
 * letter keys to upper-case (so Ctrl+Shift+S, not Ctrl+Shift+s) and
 * passes through named keys (Enter, Tab, F1, ArrowUp). Returns empty
 * string for keys we don't accept (modifier-only events get filtered
 * earlier).
 */
function normalizeKey(key: string, code: string): string {
  if (key.length === 1) return key.toUpperCase();
  // Numpad/digit codes occasionally come through as "Numpad5" — accept those.
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key.startsWith('Arrow')) return key;
  if (['Enter', 'Tab', 'Space', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(key)) {
    return key === 'Space' ? 'Space' : key;
  }
  if (code.startsWith('Numpad')) return code;
  return key;
}

/**
 * Highlight any combo assigned to more than one action. We don't BLOCK
 * the save — the user might be reassigning and the duplicate is
 * intermediate — but we make it visible.
 */
function flagDuplicates(): void {
  const counts = new Map<string, number>();
  for (const v of Object.values(editedHotkeys)) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  for (const el of Array.from(hotkeysBody.querySelectorAll<HTMLElement>('.hotkey-input'))) {
    const key = el.dataset.key!;
    const v = editedHotkeys[key];
    el.classList.toggle('duplicate', !!v && (counts.get(v) ?? 0) > 1);
  }
}

// Reset button on the hotkey card.
document.getElementById('btn-reset-hotkeys')!.addEventListener('click', () => {
  for (const k of Object.keys(HOTKEY_LABELS)) {
    editedHotkeys[k] = DEFAULT_HOTKEYS[k] ?? '';
  }
  renderHotkeyRows();
  setStatus('Hotkeys reset to defaults (not yet saved).');
});

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
  // Bail early if any binding is empty — the global shortcut layer can't
  // register an empty accelerator and we'd silently lose the action.
  for (const [key, combo] of Object.entries(editedHotkeys)) {
    if (!combo) {
      setStatus(`Hotkey for "${HOTKEY_LABELS[key]}" cannot be blank.`, true);
      return;
    }
  }
  btnSave.disabled = true;
  setStatus('Saving…');
  try {
    await api.save({
      outputDir: dir,
      firstRun: false,
      hotkeys: editedHotkeys as never,
      snapshot: { clearAnnotationsAfter: editedSnapClearAfter } as never,
    });
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
