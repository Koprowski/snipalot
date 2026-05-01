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
const btnTestLlmConnection = document.getElementById('btn-test-llm-connection') as HTMLButtonElement;
const btnFetchOpenRouterModels = document.getElementById('btn-fetch-openrouter-models') as HTMLButtonElement;
const btnFetchGeminiCliModels = document.getElementById('btn-fetch-gemini-cli-models') as HTMLButtonElement;
const btnCheckUpdates = document.getElementById('btn-check-updates') as HTMLButtonElement;
const geminiCliMissingHelpEl = document.getElementById('gemini-cli-missing-help') as HTMLElement;
const geminiCliMissingTitleEl = document.getElementById('gemini-cli-missing-title') as HTMLElement;
const geminiCliMissingExplanationEl = document.getElementById('gemini-cli-missing-explanation') as HTMLElement;
const geminiCliInstallCommandInput = document.getElementById('gemini-cli-install-command') as HTMLInputElement;
const btnCopyGeminiCliCommand = document.getElementById('btn-copy-gemini-cli-command') as HTMLButtonElement;
const btnOpenGeminiCliDocs = document.getElementById('btn-open-gemini-cli-docs') as HTMLButtonElement;
const openrouterModelFilterInput = document.getElementById('input-openrouter-model-filter') as HTMLInputElement;
const openrouterModelsSelect = document.getElementById('select-openrouter-models') as HTMLSelectElement;
const openrouterFreeOnlyCheckbox = document.getElementById('checkbox-openrouter-free-only') as HTMLInputElement;
const openrouterMaxCostInput = document.getElementById('input-openrouter-max-cost') as HTMLInputElement;
const geminiCliModelFilterInput = document.getElementById('input-gemini-cli-model-filter') as HTMLInputElement;
const geminiCliModelsSelect = document.getElementById('select-gemini-cli-models') as HTMLSelectElement;
const versionLabelEl = document.getElementById('settings-version') as HTMLElement | null;
const settingsStatusEl = document.getElementById('status') as HTMLElement;
const hotkeysBody = document.getElementById('hotkeys-body') as HTMLTableSectionElement;
const firstRunBanner = document.getElementById('first-run-banner') as HTMLElement;

// ─── hotkey label map ──────────────────────────────────────────────────

const HOTKEY_LABELS: Record<string, string> = {
  startStop: 'Start / Stop recording',
  startTrade: 'Start / Stop trade session',
  tradeMarker: 'Mark trade event',
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
  startTrade: 'Ctrl+Shift+T',
  tradeMarker: 'Ctrl+Shift+M',
  annotate: 'Ctrl+Shift+A',
  snapshot: 'Ctrl+Shift+P',
  clear: 'Ctrl+Shift+C',
  undo: 'Ctrl+Z',
  pauseResume: 'Ctrl+Shift+B',
  toggleOutline: 'Ctrl+Shift+H',
};

// Working copy of bindings — mutated as the user clicks/captures, flushed
// to disk on Save. Initialized from config in init().
const editedHotkeys: Record<string, string> = {};

// ─── init ──────────────────────────────────────────────────────────────

// Working copy of the snapshot behavior. Mutates as the user clicks the
// radio; flushed on Save.
let editedSnapClearAfter = true;
// Working copies of LLM API keys + OpenAI-compatible settings.
let editedOpenaiApiKey = '';
let editedOpenaiBaseUrl = '';
let editedOpenaiModel = '';
let editedLlmMode: 'gemini-cli' | 'api' = 'gemini-cli';
let editedGeminiCliCommand = 'gemini';
let editedGeminiCliModel = 'gemini-2.5-pro';
let fetchedGeminiCliModels: Array<{ id: string; createdAtMs: number }> = [];
let fetchedOpenrouterModels: Array<{ id: string; createdAtMs: number; inputCostPer1M: number }> = [];
// Working copy of the capture mode + countdown duration.
let editedCaptureMode: 'region' | 'fullscreen' | 'window' = 'region';
let editedCountdownSec = 3;
let lastGeminiCliDocsUrl = 'https://github.com/google-gemini/gemini-cli#installation';

async function init(): Promise<void> {
  const config = await api.getConfig();
  api.log('settings', 'loaded config', config);
  await refreshVersionAndUpdateStatus();

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

  // Capture mode + countdown.
  const cfgCap = (config as unknown as { capture?: { mode?: 'region' | 'fullscreen' | 'window'; countdownSec?: number } }).capture;
  editedCaptureMode = cfgCap?.mode ?? 'region';
  editedCountdownSec = cfgCap?.countdownSec ?? 3;
  const capRegion = document.getElementById('capture-region') as HTMLInputElement;
  const capFullscreen = document.getElementById('capture-fullscreen') as HTMLInputElement;
  const capWindow = document.getElementById('capture-window') as HTMLInputElement;
  if (editedCaptureMode === 'fullscreen') capFullscreen.checked = true;
  else if (editedCaptureMode === 'window') capWindow.checked = true;
  else capRegion.checked = true;
  capRegion.addEventListener('change', () => { if (capRegion.checked) editedCaptureMode = 'region'; });
  capFullscreen.addEventListener('change', () => { if (capFullscreen.checked) editedCaptureMode = 'fullscreen'; });
  capWindow.addEventListener('change', () => { if (capWindow.checked) editedCaptureMode = 'window'; });

  // Countdown control: slider (0..10) + custom number input. The two
  // stay in sync — drag the slider, the number updates; type a number,
  // the slider clamps to its 0..10 range but the actual stored value
  // can be anything ≥0 (e.g. 30s) so power users aren't capped at 10.
  const countdownSlider = document.getElementById('countdown-slider') as HTMLInputElement;
  const countdownCustom = document.getElementById('countdown-custom') as HTMLInputElement;
  countdownSlider.value = String(Math.min(10, Math.max(0, editedCountdownSec)));
  countdownCustom.value = String(editedCountdownSec);
  countdownSlider.addEventListener('input', () => {
    const v = Number(countdownSlider.value);
    editedCountdownSec = v;
    countdownCustom.value = String(v);
  });
  countdownCustom.addEventListener('input', () => {
    const raw = Number(countdownCustom.value);
    if (Number.isFinite(raw) && raw >= 0) {
      editedCountdownSec = Math.floor(raw);
      countdownSlider.value = String(Math.min(10, Math.max(0, editedCountdownSec)));
    }
  });

  // LLM API key fields.
  const cfgTrade = (config as unknown as {
    trade?: {
      openaiApiKey?: string;
      openaiBaseUrl?: string;
      openaiModel?: string;
      llmMode?: 'gemini-cli' | 'api';
      geminiCliCommand?: string;
      geminiCliModel?: string;
    }
  }).trade;

  editedOpenaiApiKey = cfgTrade?.openaiApiKey ?? '';
  editedOpenaiBaseUrl = cfgTrade?.openaiBaseUrl ?? 'https://openrouter.ai/api/v1';
  editedOpenaiModel = cfgTrade?.openaiModel ?? 'google/gemini-2.5-flash';
  editedLlmMode = cfgTrade?.llmMode ?? 'gemini-cli';
  editedGeminiCliCommand = cfgTrade?.geminiCliCommand ?? 'gemini';
  editedGeminiCliModel = normalizeGeminiCliModel(cfgTrade?.geminiCliModel ?? 'gemini-2.5-pro');

  const llmModeSelect = document.getElementById('trade-llm-mode') as HTMLSelectElement;
  llmModeSelect.value = editedLlmMode;
  llmModeSelect.addEventListener('change', () => {
    editedLlmMode = llmModeSelect.value === 'api' ? 'api' : 'gemini-cli';
  });

  const geminiCliCommandInput = document.getElementById('input-gemini-cli-command') as HTMLInputElement;
  geminiCliCommandInput.value = editedGeminiCliCommand;
  geminiCliCommandInput.addEventListener('input', () => {
    editedGeminiCliCommand = geminiCliCommandInput.value.trim();
  });

  const geminiCliModelInput = document.getElementById('input-gemini-cli-model') as HTMLInputElement;
  geminiCliModelInput.value = editedGeminiCliModel;
  geminiCliModelInput.addEventListener('input', () => {
    editedGeminiCliModel = geminiCliModelInput.value.trim();
  });
  geminiCliModelFilterInput.addEventListener('input', () => renderGeminiCliModelOptions());
  geminiCliModelsSelect.addEventListener('change', () => {
    const chosen = geminiCliModelsSelect.value;
    if (!chosen) return;
    editedGeminiCliModel = chosen;
    geminiCliModelInput.value = chosen;
  });

  const openaiKeyInput = document.getElementById('input-openai-key') as HTMLInputElement;
  const btnShowOpenaiKey = document.getElementById('btn-show-openai-key') as HTMLButtonElement;
  openaiKeyInput.value = editedOpenaiApiKey;
  openaiKeyInput.addEventListener('input', () => { editedOpenaiApiKey = openaiKeyInput.value.trim(); });
  btnShowOpenaiKey.addEventListener('click', () => {
    openaiKeyInput.type = openaiKeyInput.type === 'password' ? 'text' : 'password';
    btnShowOpenaiKey.textContent = openaiKeyInput.type === 'password' ? 'Show' : 'Hide';
  });

  const openaiBaseUrlInput = document.getElementById('input-openai-base-url') as HTMLInputElement;
  openaiBaseUrlInput.value = editedOpenaiBaseUrl;
  openaiBaseUrlInput.addEventListener('input', () => { editedOpenaiBaseUrl = openaiBaseUrlInput.value.trim(); });

  const openaiModelInput = document.getElementById('input-openai-model') as HTMLInputElement;
  openaiModelInput.value = editedOpenaiModel;
  openaiModelInput.addEventListener('input', () => { editedOpenaiModel = openaiModelInput.value.trim(); });
  openrouterModelFilterInput.addEventListener('input', () => renderOpenrouterModelOptions());
  openrouterFreeOnlyCheckbox.addEventListener('change', () => renderOpenrouterModelOptions());
  openrouterMaxCostInput.addEventListener('input', () => renderOpenrouterModelOptions());
  openrouterModelsSelect.addEventListener('change', () => {
    const chosen = openrouterModelsSelect.value;
    if (!chosen) return;
    editedOpenaiModel = chosen;
    openaiModelInput.value = chosen;
  });
  renderOpenrouterModelOptions();
  renderGeminiCliModelOptions();

  // ── Gemini CLI Google sign-in wiring ─────────────────────────────
  initGeminiSignin();
}

/**
 * Wire up the "Sign in with Google" / "Sign out" controls. Polls status
 * on Settings open and after each sign-in/out completes. Only the relevant
 * buttons are visible at any time.
 */
function initGeminiSignin(): void {
  const statusEl = document.getElementById('gemini-signin-status') as HTMLElement;
  const btnIn = document.getElementById('btn-gemini-signin') as HTMLButtonElement;
  const btnOut = document.getElementById('btn-gemini-signout') as HTMLButtonElement;
  const btnCancel = document.getElementById('btn-gemini-signin-cancel') as HTMLButtonElement;

  const setIdleState = (signedIn: boolean, subject?: string | null): void => {
    btnIn.disabled = false;
    btnOut.disabled = false;
    btnCancel.style.display = 'none';
    btnIn.style.display = signedIn ? 'none' : 'inline-block';
    btnOut.style.display = signedIn ? 'inline-block' : 'none';
    statusEl.textContent = signedIn
      ? `Signed in${subject ? ` as ${subject}` : ''}.`
      : 'Not signed in. Click below to sign in with your Google account.';
    statusEl.style.color = signedIn ? 'var(--success, #16a34a)' : 'var(--muted)';
  };

  const refreshStatus = async (): Promise<void> => {
    try {
      const result = await api.geminiCliSigninStatus();
      setIdleState(result.signedIn, result.subject);
    } catch (err) {
      api.log('settings', 'gemini signin status failed', String(err));
      statusEl.textContent = 'Could not check sign-in status.';
      statusEl.style.color = 'var(--danger, #ef4444)';
    }
  };

  btnIn.addEventListener('click', async () => {
    btnIn.disabled = true;
    btnOut.disabled = true;
    btnCancel.style.display = 'inline-block';
    statusEl.textContent = 'Opening browser for Google login… complete the flow there. This window will detect when you finish.';
    statusEl.style.color = 'var(--muted)';
    try {
      const result = await api.geminiCliSignin({ command: editedGeminiCliCommand || 'gemini' });
      if (result.ok) {
        setIdleState(true, result.subject);
        statusEl.textContent = result.message;
        statusEl.style.color = 'var(--success, #16a34a)';
      } else {
        await refreshStatus();
        statusEl.textContent = result.message;
        statusEl.style.color = 'var(--danger, #ef4444)';
      }
    } catch (err) {
      await refreshStatus();
      statusEl.textContent = `Sign-in failed: ${(err as Error).message}`;
      statusEl.style.color = 'var(--danger, #ef4444)';
    }
  });

  btnCancel.addEventListener('click', async () => {
    btnCancel.disabled = true;
    try { await api.geminiCliSigninCancel(); } catch { /* ignore */ }
    btnCancel.disabled = false;
    await refreshStatus();
  });

  btnOut.addEventListener('click', async () => {
    btnOut.disabled = true;
    try {
      await api.geminiCliSignout();
    } catch (err) {
      api.log('settings', 'gemini signout failed', String(err));
    }
    await refreshStatus();
  });

  void refreshStatus();
}

async function refreshVersionAndUpdateStatus(): Promise<void> {
  try {
    const info = await api.getAppInfo();
    if (versionLabelEl) versionLabelEl.textContent = `Version: ${info.version}`;
    const update = await api.checkForUpdates();
    if (!update.ok) {
      if (versionLabelEl) versionLabelEl.textContent = `Version: ${info.version} · Update check unavailable`;
      return;
    }
    if (update.updateAvailable && update.latestVersion) {
      if (versionLabelEl) versionLabelEl.textContent = `Version: ${info.version} · Update available (${update.latestVersion})`;
      return;
    }
    if (versionLabelEl) versionLabelEl.textContent = `Version: ${info.version} · Up to date`;
  } catch {
    // Keep UI usable even if update check fails.
  }
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

// ─── test LLM connection (no save required) ────────────────────────────

btnTestLlmConnection.addEventListener('click', async () => {
  const openaiKey = editedOpenaiApiKey.trim();
  const baseUrl = editedOpenaiBaseUrl.trim() || 'https://openrouter.ai/api/v1';
  const model = editedOpenaiModel.trim() || 'google/gemini-2.5-flash';
  const cliCommand = editedGeminiCliCommand.trim() || 'gemini';
  const cliModel = normalizeGeminiCliModel(editedGeminiCliModel.trim() || 'gemini-2.5-pro');

  if (editedLlmMode === 'api' && !openaiKey) {
    setStatus('API mode: enter OpenRouter/OpenAI API key first.', true);
    return;
  }

  btnTestLlmConnection.disabled = true;
  const prevSaveDisabled = btnSave.disabled;
  btnSave.disabled = true;
  setStatus(editedLlmMode === 'gemini-cli' ? 'Testing Gemini CLI connection…' : 'Testing API connection…');
  hideGeminiCliMissingHelp();
  try {
    const result = await api.testLlmConnection({
      llmMode: editedLlmMode,
      geminiCliCommand: cliCommand,
      geminiCliModel: cliModel,
      openaiApiKey: openaiKey || undefined,
      openaiBaseUrl: baseUrl,
      openaiModel: model,
    });
    if (result.ok) {
      setStatus(result.message);
      return;
    }
    if (result.guidance?.kind === 'gemini-cli-missing') {
      showGeminiCliMissingHelp(result.guidance);
    }
    setStatus(result.message, true);
  } catch (err) {
    hideGeminiCliMissingHelp();
    setStatus(`LLM connection test failed: ${(err as Error).message}`, true);
  } finally {
    btnTestLlmConnection.disabled = false;
    btnSave.disabled = prevSaveDisabled;
  }
});

btnFetchOpenRouterModels.addEventListener('click', async () => {
  btnFetchOpenRouterModels.disabled = true;
  setStatus('Fetching latest OpenRouter models…');
  try {
    const models = await api.listOpenRouterModels();
    fetchedOpenrouterModels = models
      .filter((m) => !!m.id)
      .map((m) => ({
        id: m.id,
        createdAtMs: m.createdAtMs ?? 0,
        inputCostPer1M: Number.isFinite(m.inputCostPer1M) ? m.inputCostPer1M : 0,
      }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    renderOpenrouterModelOptions();
    setStatus(`Fetched ${fetchedOpenrouterModels.length} OpenRouter models.`);
  } catch (err) {
    setStatus(`Failed to fetch OpenRouter models: ${(err as Error).message}`, true);
  } finally {
    btnFetchOpenRouterModels.disabled = false;
  }
});

btnFetchGeminiCliModels.addEventListener('click', async () => {
  btnFetchGeminiCliModels.disabled = true;
  setStatus('Loading Gemini CLI model list…');
  try {
    const models = await api.listGeminiCliModels(editedGeminiCliCommand.trim() || 'gemini');
    fetchedGeminiCliModels = models
      .filter((m) => !!m.id)
      .map((m) => ({ id: m.id, createdAtMs: m.createdAtMs ?? 0 }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
    renderGeminiCliModelOptions();
    setStatus(`Loaded ${fetchedGeminiCliModels.length} Gemini CLI models. Preview models may require newer CLI/account access.`);
  } catch (err) {
    setStatus(`Failed to fetch Gemini CLI models: ${(err as Error).message}`, true);
  } finally {
    btnFetchGeminiCliModels.disabled = false;
  }
});

btnCheckUpdates.addEventListener('click', async () => {
  btnCheckUpdates.disabled = true;
  const prevSaveDisabled = btnSave.disabled;
  btnSave.disabled = true;
  setStatus('Checking for updates…');
  try {
    const result = await api.checkForUpdates();
    if (!result.ok) {
      setStatus(`Update check failed: ${result.message}`, true);
      return;
    }
    const info = await api.getAppInfo();
    if (!result.updateAvailable || !result.latestVersion || !result.releaseUrl) {
      if (versionLabelEl) versionLabelEl.textContent = `Version: ${info.version} · Up to date`;
      setStatus(`Up to date (${info.version})`);
      return;
    }
    if (versionLabelEl) versionLabelEl.textContent = `Version: ${info.version} · Update available (${result.latestVersion})`;
    setStatus(`Update available: ${result.latestVersion} — opening download page…`);
    await api.openLatestRelease();
  } catch (err) {
    setStatus(`Update check failed: ${(err as Error).message}`, true);
  } finally {
    btnCheckUpdates.disabled = false;
    btnSave.disabled = prevSaveDisabled;
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
      capture: { mode: editedCaptureMode, countdownSec: editedCountdownSec } as never,
      trade: {
        llmMode: editedLlmMode,
        geminiCliCommand: editedGeminiCliCommand,
        geminiCliModel: editedGeminiCliModel,
        openaiApiKey: editedOpenaiApiKey,
        openaiBaseUrl: editedOpenaiBaseUrl,
        openaiModel: editedOpenaiModel,
      } as never,
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
btnClose.addEventListener('click', () => {
  api.close();
});

// ─── helpers ───────────────────────────────────────────────────────────

function setStatus(msg: string, isError = false): void {
  settingsStatusEl.textContent = msg;
  settingsStatusEl.className = 'status' + (isError ? ' err' : msg ? ' ok' : '');
}

function hideGeminiCliMissingHelp(): void {
  geminiCliMissingHelpEl.style.display = 'none';
  geminiCliMissingTitleEl.textContent = '';
  geminiCliMissingExplanationEl.textContent = '';
  geminiCliInstallCommandInput.value = '';
}

function showGeminiCliMissingHelp(guidance: {
  kind: 'gemini-cli-missing';
  title: string;
  explanation: string;
  installCommand: string;
  docsUrl: string;
}): void {
  geminiCliMissingTitleEl.textContent = guidance.title;
  geminiCliMissingExplanationEl.textContent = guidance.explanation;
  geminiCliInstallCommandInput.value = guidance.installCommand;
  lastGeminiCliDocsUrl = guidance.docsUrl;
  geminiCliMissingHelpEl.style.display = 'flex';
}

btnCopyGeminiCliCommand.addEventListener('click', async () => {
  const command = geminiCliInstallCommandInput.value.trim();
  if (!command) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      geminiCliInstallCommandInput.focus();
      geminiCliInstallCommandInput.select();
      document.execCommand('copy');
      geminiCliInstallCommandInput.setSelectionRange(command.length, command.length);
    }
    setStatus('Install command copied to clipboard.');
  } catch {
    setStatus('Could not copy automatically. Copy the command from the field above.', true);
  }
});

btnOpenGeminiCliDocs.addEventListener('click', async () => {
  try {
    await api.openUrl(lastGeminiCliDocsUrl);
  } catch (err) {
    setStatus(`Could not open install guide: ${(err as Error).message}`, true);
  }
});

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderOpenrouterModelOptions(): void {
  const q = (openrouterModelFilterInput.value || '').toLowerCase().trim();
  const freeOnly = openrouterFreeOnlyCheckbox.checked;
  const maxCost = Number(openrouterMaxCostInput.value);
  const hasMaxCost = Number.isFinite(maxCost) && maxCost >= 0;
  const filtered = fetchedOpenrouterModels.filter((m) => {
    if (q && !m.id.toLowerCase().includes(q)) return false;
    if (freeOnly && m.inputCostPer1M > 0) return false;
    if (hasMaxCost && m.inputCostPer1M > maxCost) return false;
    return true;
  });
  openrouterModelsSelect.innerHTML = '';
  for (const model of filtered) {
    const opt = document.createElement('option');
    opt.value = model.id;
    const priceLabel = model.inputCostPer1M <= 0 ? 'free' : `$${model.inputCostPer1M.toFixed(2)}/1M in`;
    opt.textContent = `${model.id}  (${priceLabel})`;
    openrouterModelsSelect.appendChild(opt);
  }
  // Auto-size: shrink the listbox to whatever's visible (max 5 rows, min 1)
  // so an empty list takes minimal space and a small list doesn't leave a
  // big empty rectangle behind.
  openrouterModelsSelect.size = Math.max(1, Math.min(5, filtered.length));
}

function renderGeminiCliModelOptions(): void {
  const q = (geminiCliModelFilterInput.value || '').toLowerCase().trim();
  const filtered = q
    ? fetchedGeminiCliModels.filter((m) => m.id.toLowerCase().includes(q))
    : fetchedGeminiCliModels;
  geminiCliModelsSelect.innerHTML = '';
  for (const model of filtered) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.id;
    geminiCliModelsSelect.appendChild(opt);
  }
  geminiCliModelsSelect.size = Math.max(1, Math.min(5, filtered.length));
}

function normalizeGeminiCliModel(model: string): string {
  return model === 'gemini-3.1-pro-preview' ? 'gemini-2.5-pro' : model;
}

// ─── boot ──────────────────────────────────────────────────────────────

init().catch((err) => {
  api.log('settings', 'init error', String(err));
  setStatus('Failed to load settings.', true);
});
