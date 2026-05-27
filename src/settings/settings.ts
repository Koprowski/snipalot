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
const btnCheckDependencies = document.getElementById('btn-check-dependencies') as HTMLButtonElement;
const btnInstallWhisper = document.getElementById('btn-install-whisper') as HTMLButtonElement;
const btnInstallGeminiCli = document.getElementById('btn-install-gemini-cli') as HTMLButtonElement;
const btnInstallNode = document.getElementById('btn-install-node') as HTMLButtonElement;
const dependencyStatusEl = document.getElementById('dependency-status') as HTMLElement;
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
const versionLabelEl = btnCheckUpdates;
const settingsStatusEl = document.getElementById('status') as HTMLElement;
const settingsStatusTextEl = document.getElementById('status-text') as HTMLElement;
const downloadProgressEl = document.getElementById('download-progress') as HTMLElement;
const downloadProgressFillEl = document.getElementById('download-progress-fill') as HTMLElement;
const hotkeysBody = document.getElementById('hotkeys-body') as HTMLTableSectionElement;
const hotkeySafetyWarningEl = document.getElementById('hotkey-safety-warning') as HTMLElement;
const firstRunBanner = document.getElementById('first-run-banner') as HTMLElement;
const setupModalEl = document.getElementById('setup-modal') as HTMLElement;
const setupModalStatusEl = document.getElementById('setup-modal-status') as HTMLElement;
const btnSetupNext = document.getElementById('btn-setup-next') as HTMLButtonElement;
const btnSetupSkip = document.getElementById('btn-setup-skip') as HTMLButtonElement;
const setupCheckWhisper = document.getElementById('setup-check-whisper') as HTMLInputElement;
const setupCheckNode = document.getElementById('setup-check-node') as HTMLInputElement;
const setupCheckGemini = document.getElementById('setup-check-gemini') as HTMLInputElement;
const launcherShowRecordInput = document.getElementById('launcher-show-record') as HTMLInputElement;
const launcherShowScreenshotInput = document.getElementById('launcher-show-screenshot') as HTMLInputElement;
const launcherShowTradeInput = document.getElementById('launcher-show-trade') as HTMLInputElement;
const feedbackGenerateMp4Input = document.getElementById('feedback-generate-mp4') as HTMLInputElement;
const feedbackGenerateGifInput = document.getElementById('feedback-generate-gif') as HTMLInputElement;
const wilyTraderVersionEl = document.getElementById('wilytrader-version') as HTMLElement;
const wilyTraderLocationBtn = document.getElementById('btn-wilytrader-location') as HTMLButtonElement;
const wilyTraderStatusEl = document.getElementById('wilytrader-status') as HTMLElement;
const btnRefreshWilyTraderStatus = document.getElementById('btn-refresh-wilytrader-status') as HTMLButtonElement;
const btnMoveWilyTraderFolder = document.getElementById('btn-move-wilytrader-folder') as HTMLButtonElement;
const btnOpenChromeExtensions = document.getElementById('btn-open-chrome-extensions') as HTMLButtonElement;

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
  startStop: 'Ctrl+Alt+S',
  startTrade: 'Ctrl+Alt+T',
  tradeMarker: 'Ctrl+Shift+X',
  annotate: 'Ctrl+Shift+A',
  snapshot: 'Ctrl+Alt+P',
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
let editedGeminiCliModel = 'gemini-3.1-pro-preview';
let fetchedGeminiCliModels: Array<{ id: string; createdAtMs: number }> = [];
let fetchedOpenrouterModels: Array<{ id: string; createdAtMs: number; inputCostPer1M: number }> = [];
// Working copy of the countdown duration.
let editedCountdownSec = 3;
let editedFeedbackOutputs = {
  generateMp4: false,
  generateGif: false,
};
let editedVisibleActions = {
  record: true,
  screenshot: true,
  trade: false,
};
let lastGeminiCliDocsUrl = 'https://github.com/google-gemini/gemini-cli#installation';
type DependencyStatus = Awaited<ReturnType<typeof api.checkDependencies>>;
let lastDependencyStatus: DependencyStatus | null = null;
let firstRunOnboarding = false;

async function init(): Promise<void> {
  const config = await api.getConfig();
  api.log('settings', 'loaded config', {
    outputDir: config.outputDir,
    llmMode: config.trade?.llmMode,
    geminiCliModel: config.trade?.geminiCliModel,
    hasOpenAiApiKey: Boolean(config.trade?.openaiApiKey),
    captureMode: config.capture?.mode,
    feedback: config.feedback,
    firstRun: config.firstRun,
  });
  await refreshVersionAndUpdateStatus();
  await refreshWilyTraderStatus();

  // Output dir
  dirInput.value = config.outputDir ?? '';

  // First-run banner
  if (config.firstRun) {
    firstRunOnboarding = true;
    firstRunBanner.style.display = 'block';
  }

  // Hotkeys table
  const hk = (config.hotkeys ?? {}) as unknown as Record<string, string>;
  for (const key of Object.keys(HOTKEY_LABELS)) {
    editedHotkeys[key] = hk[key] ?? DEFAULT_HOTKEYS[key] ?? '';
  }
  renderHotkeyRows();

  const cfgLauncher = (config as unknown as {
    launcher?: {
      visibleActions?: {
        record?: boolean;
        screenshot?: boolean;
        trade?: boolean;
      };
    };
  }).launcher;
  editedVisibleActions = {
    record: cfgLauncher?.visibleActions?.record ?? true,
    screenshot: cfgLauncher?.visibleActions?.screenshot ?? true,
    trade: cfgLauncher?.visibleActions?.trade ?? false,
  };
  launcherShowRecordInput.checked = editedVisibleActions.record;
  launcherShowScreenshotInput.checked = editedVisibleActions.screenshot;
  launcherShowTradeInput.checked = editedVisibleActions.trade;
  const syncVisibleActions = (): void => {
    editedVisibleActions = {
      record: launcherShowRecordInput.checked,
      screenshot: launcherShowScreenshotInput.checked,
      trade: launcherShowTradeInput.checked,
    };
  };
  launcherShowRecordInput.addEventListener('change', syncVisibleActions);
  launcherShowScreenshotInput.addEventListener('change', syncVisibleActions);
  launcherShowTradeInput.addEventListener('change', syncVisibleActions);

  // Snapshot behavior radios. Default to clear-after if config is missing
  // the field (older configs predate this setting).
  const cfgSnap = (config as unknown as { snapshot?: { clearAnnotationsAfter?: boolean } }).snapshot;
  editedSnapClearAfter = cfgSnap?.clearAnnotationsAfter ?? true;
  const radioClear = document.getElementById('snap-clear') as HTMLInputElement;
  const radioKeep = document.getElementById('snap-keep') as HTMLInputElement;
  if (editedSnapClearAfter) radioClear.checked = true; else radioKeep.checked = true;
  radioClear.addEventListener('change', () => { if (radioClear.checked) editedSnapClearAfter = true; });
  radioKeep.addEventListener('change', () => { if (radioKeep.checked) editedSnapClearAfter = false; });

  const cfgFeedback = (config as unknown as {
    feedback?: {
      generateMp4?: boolean;
      generateGif?: boolean;
    };
  }).feedback;
  editedFeedbackOutputs = {
    generateMp4: cfgFeedback?.generateMp4 ?? false,
    generateGif: cfgFeedback?.generateGif ?? false,
  };
  feedbackGenerateMp4Input.checked = editedFeedbackOutputs.generateMp4;
  feedbackGenerateGifInput.checked = editedFeedbackOutputs.generateGif;
  feedbackGenerateMp4Input.addEventListener('change', () => {
    editedFeedbackOutputs.generateMp4 = feedbackGenerateMp4Input.checked;
  });
  feedbackGenerateGifInput.addEventListener('change', () => {
    editedFeedbackOutputs.generateGif = feedbackGenerateGifInput.checked;
  });

  // Recording countdown. Capture mode is controlled from the launcher.
  const cfgCap = (config as unknown as { capture?: { countdownSec?: number } }).capture;
  editedCountdownSec = cfgCap?.countdownSec ?? 3;

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
  editedGeminiCliModel = cfgTrade?.geminiCliModel ?? 'gemini-3.1-pro-preview';

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

  btnCheckDependencies.addEventListener('click', () => {
    void refreshDependencyStatus();
  });
  btnInstallWhisper.addEventListener('click', () => {
    void installWhisperFromSettings();
  });
  btnInstallGeminiCli.addEventListener('click', () => {
    void installGeminiCliFromSettings();
  });
  btnInstallNode.addEventListener('click', () => {
    void installNodeFromSettings();
  });
  btnSetupSkip.addEventListener('click', () => {
    setupModalEl.style.display = 'none';
  });
  btnSetupNext.addEventListener('click', () => {
    void runSetupModalInstall();
  });
  btnRefreshWilyTraderStatus.addEventListener('click', () => {
    void refreshWilyTraderStatus();
  });
  wilyTraderLocationBtn.addEventListener('click', () => {
    void openWilyTraderInstallFolder();
  });
  btnMoveWilyTraderFolder.addEventListener('click', () => {
    void moveWilyTraderInstallFolder();
  });
  btnOpenChromeExtensions.addEventListener('click', () => {
    void openChromeExtensionsPage();
  });
  void refreshDependencyStatus({ maybeShowFirstRunModal: config.firstRun });

  // ── Gemini CLI Google sign-in wiring ─────────────────────────────
  initGeminiSignin();
}

async function refreshWilyTraderStatus(): Promise<void> {
  btnRefreshWilyTraderStatus.disabled = true;
  wilyTraderVersionEl.textContent = 'Checking...';
  wilyTraderLocationBtn.textContent = 'Checking...';
  wilyTraderLocationBtn.disabled = true;
  btnMoveWilyTraderFolder.disabled = true;
  wilyTraderStatusEl.textContent = '';
  try {
    const result = await api.getWilyTraderStatus();
    if (!result.installed) {
      wilyTraderVersionEl.textContent = 'Not installed';
      wilyTraderLocationBtn.textContent = 'No local WilyTrader folder found';
      wilyTraderLocationBtn.disabled = true;
      btnMoveWilyTraderFolder.disabled = true;
      wilyTraderStatusEl.textContent = result.message;
      return;
    }
    wilyTraderVersionEl.textContent = result.version ?? 'Unknown';
    wilyTraderLocationBtn.textContent = result.extensionPath ?? result.repoPath ?? 'Unknown location';
    wilyTraderLocationBtn.disabled = !result.extensionPath;
    btnMoveWilyTraderFolder.disabled = false;
    const chromePaths = result.chromeExtensionPaths.filter(Boolean);
    const loadedElsewhere = Boolean(
      result.extensionPath &&
      chromePaths.some((chromePath) => chromePath.toLowerCase() !== result.extensionPath!.toLowerCase())
    );
    const lines = [
      result.isGitRepo ? 'Detected from a local Git checkout.' : 'Detected from local extension files.',
      result.repoPath ? `WilyTrader files folder: ${result.repoPath}` : null,
      result.configuredPath ? `Snipalot preferred folder: ${result.configuredPath}` : null,
      chromePaths.length > 0
        ? `Chrome loaded path: ${chromePaths.join('; ')}`
        : 'Chrome does not appear to have WilyTrader loaded yet.',
      loadedElsewhere
        ? 'After moving, remove/reload WilyTrader in Chrome so it points at the new folder.'
        : null,
    ].filter((line): line is string => Boolean(line));
    wilyTraderStatusEl.textContent = lines.join('\n');
  } catch (err) {
    wilyTraderVersionEl.textContent = 'Unavailable';
    wilyTraderLocationBtn.textContent = 'Could not check WilyTrader';
    wilyTraderLocationBtn.disabled = true;
    btnMoveWilyTraderFolder.disabled = true;
    wilyTraderStatusEl.textContent = `WilyTrader status check failed: ${(err as Error).message}`;
  } finally {
    btnRefreshWilyTraderStatus.disabled = false;
  }
}

async function openWilyTraderInstallFolder(): Promise<void> {
  wilyTraderLocationBtn.disabled = true;
  try {
    const result = await api.openWilyTraderFolder();
    if (!result.ok) {
      setStatus(result.message, true);
      return;
    }
    setStatus(result.message);
  } catch (err) {
    setStatus(`Could not open WilyTrader folder: ${(err as Error).message}`, true);
  } finally {
    wilyTraderLocationBtn.disabled = false;
  }
}

async function moveWilyTraderInstallFolder(): Promise<void> {
  btnMoveWilyTraderFolder.disabled = true;
  setStatus('Choose an empty destination folder for the whole WilyTrader files folder, or an existing WilyTrader folder to use.');
  try {
    const result = await api.moveWilyTraderFolder();
    if (!result.ok) {
      setStatus(result.message, true);
      return;
    }
    setStatus(result.message);
    await refreshWilyTraderStatus();
  } catch (err) {
    setStatus(`Could not move WilyTrader folder: ${(err as Error).message}`, true);
  } finally {
    btnMoveWilyTraderFolder.disabled = false;
  }
}

async function openChromeExtensionsPage(): Promise<void> {
  btnOpenChromeExtensions.disabled = true;
  try {
    await api.openChromeExtensions();
  } catch (err) {
    setStatus(`Could not open Chrome Extensions: ${(err as Error).message}`, true);
  } finally {
    btnOpenChromeExtensions.disabled = false;
  }
}

function formatDependencyStatus(result: DependencyStatus): string {
  return [
    `${result.whisper.ok ? 'OK' : 'Missing'} - Whisper: ${result.whisper.message}`,
    `${result.node.ok ? 'OK' : 'Missing'} - Node/npm: ${result.node.message}`,
    `${result.geminiCli.ok ? 'OK' : 'Missing'} - Gemini CLI: ${result.geminiCli.message}`,
  ].join('\n');
}

function updateDependencyButtons(result: DependencyStatus): void {
  btnInstallWhisper.disabled = result.whisper.ok;
  btnInstallNode.disabled = result.node.ok;
  btnInstallGeminiCli.disabled = !result.node.ok || result.geminiCli.ok;
}

function updateSetupModalChecklist(result: DependencyStatus): void {
  const rows = [
    { input: setupCheckWhisper, ok: result.whisper.ok },
    { input: setupCheckNode, ok: result.node.ok },
    { input: setupCheckGemini, ok: result.geminiCli.ok },
  ];
  for (const row of rows) {
    row.input.checked = !row.ok;
    row.input.disabled = row.ok;
    row.input.closest('.setup-check-row')?.classList.toggle('installed', row.ok);
  }
}

function maybeShowSetupModal(result: DependencyStatus): void {
  if (!firstRunOnboarding) return;
  if (result.whisper.ok && result.node.ok && result.geminiCli.ok) return;
  updateSetupModalChecklist(result);
  setupModalStatusEl.textContent = formatDependencyStatus(result);
  setupModalEl.style.display = 'flex';
}

async function refreshDependencyStatus(options?: { maybeShowFirstRunModal?: boolean }): Promise<DependencyStatus | null> {
  dependencyStatusEl.textContent = 'Checking dependencies...';
  btnCheckDependencies.disabled = true;
  try {
    const result = await api.checkDependencies({
      geminiCliCommand: editedGeminiCliCommand.trim() || 'gemini',
    });
    lastDependencyStatus = result;
    dependencyStatusEl.textContent = formatDependencyStatus(result);
    updateDependencyButtons(result);
    if (options?.maybeShowFirstRunModal) maybeShowSetupModal(result);
    return result;
  } catch (err) {
    dependencyStatusEl.textContent = `Dependency check failed: ${(err as Error).message}`;
    btnInstallWhisper.disabled = false;
    btnInstallNode.disabled = false;
    btnInstallGeminiCli.disabled = false;
    return null;
  } finally {
    btnCheckDependencies.disabled = false;
  }
}

async function installWhisperFromSettings(): Promise<void> {
  btnInstallWhisper.disabled = true;
  btnCheckDependencies.disabled = true;
  const previousLabel = btnInstallWhisper.textContent || 'Install Whisper';
  btnInstallWhisper.textContent = 'Installing...';
  dependencyStatusEl.textContent = 'Installing Whisper... downloading the local speech model can take a few minutes.';
  try {
    const result = await api.installWhisper();
    if (!result.ok) {
      dependencyStatusEl.textContent = result.message;
      btnInstallWhisper.disabled = false;
      return;
    }
    dependencyStatusEl.textContent = `${result.message}\n\nRechecking dependencies...`;
    await refreshDependencyStatus();
  } catch (err) {
    dependencyStatusEl.textContent = `Whisper install failed: ${(err as Error).message}`;
    btnInstallWhisper.disabled = false;
  } finally {
    btnCheckDependencies.disabled = false;
    btnInstallWhisper.textContent = previousLabel;
  }
}

async function installNodeFromSettings(): Promise<void> {
  btnInstallNode.disabled = true;
  btnCheckDependencies.disabled = true;
  const previousLabel = btnInstallNode.textContent || 'Install Node.js';
  btnInstallNode.textContent = 'Installing...';
  dependencyStatusEl.textContent = 'Installing Node.js LTS with winget... Windows may ask you to confirm the install.';
  try {
    const result = await api.installNode();
    if (!result.ok) {
      dependencyStatusEl.textContent = `${result.message}${result.stderrTail ? `\n\n${result.stderrTail}` : ''}`;
      btnInstallNode.disabled = false;
      return;
    }
    dependencyStatusEl.textContent = `${result.message}\n\nRechecking dependencies...`;
    await refreshDependencyStatus();
  } catch (err) {
    dependencyStatusEl.textContent = `Node.js install failed: ${(err as Error).message}`;
    btnInstallNode.disabled = false;
  } finally {
    btnCheckDependencies.disabled = false;
    btnInstallNode.textContent = previousLabel;
  }
}

async function installGeminiCliFromSettings(): Promise<void> {
  btnInstallGeminiCli.disabled = true;
  btnCheckDependencies.disabled = true;
  const previousLabel = btnInstallGeminiCli.textContent || 'Install Gemini CLI';
  btnInstallGeminiCli.textContent = 'Installing...';
  dependencyStatusEl.textContent = 'Installing Gemini CLI with npm... this can take a minute.';
  try {
    const result = await api.installGeminiCli();
    if (!result.ok) {
      dependencyStatusEl.textContent = `${result.message}${result.stderrTail ? `\n\n${result.stderrTail}` : ''}`;
      btnInstallGeminiCli.disabled = false;
      return;
    }
    dependencyStatusEl.textContent = `${result.message}\n\nRechecking dependencies...`;
    await refreshDependencyStatus();
  } catch (err) {
    dependencyStatusEl.textContent = `Gemini CLI install failed: ${(err as Error).message}`;
    btnInstallGeminiCli.disabled = false;
  } finally {
    btnCheckDependencies.disabled = false;
    btnInstallGeminiCli.textContent = previousLabel;
  }
}

async function runSetupModalInstall(): Promise<void> {
  btnSetupNext.disabled = true;
  btnSetupSkip.disabled = true;
  btnSetupNext.textContent = 'Installing...';
  const lines: string[] = [];
  const setModalStatus = (line: string): void => {
    lines.push(line);
    setupModalStatusEl.textContent = lines.join('\n');
  };

  try {
    const before = lastDependencyStatus ?? await refreshDependencyStatus();
    if (!before) {
      setModalStatus('Could not check dependencies. Use the checklist in Settings below.');
      return;
    }

    if (setupCheckNode.checked && !before.node.ok) {
      setModalStatus('Installing Node.js LTS...');
      const node = await api.installNode();
      setModalStatus(node.message);
      await refreshDependencyStatus();
    }

    if (setupCheckWhisper.checked && !(lastDependencyStatus?.whisper.ok)) {
      setModalStatus('Installing Whisper...');
      const whisper = await api.installWhisper();
      setModalStatus(whisper.message);
      await refreshDependencyStatus();
    }

    if (setupCheckGemini.checked && !(lastDependencyStatus?.geminiCli.ok)) {
      if (!(lastDependencyStatus?.node.ok)) {
        setModalStatus('Gemini CLI needs Node/npm. If Node was just installed, restart Snipalot and run setup again.');
      } else {
        setModalStatus('Installing Gemini CLI...');
        const gemini = await api.installGeminiCli();
        setModalStatus(gemini.ok ? gemini.message : `${gemini.message}${gemini.stderrTail ? `\n${gemini.stderrTail}` : ''}`);
        await refreshDependencyStatus();
      }
    }

    const finalStatus = await refreshDependencyStatus();
    if (finalStatus) {
      updateSetupModalChecklist(finalStatus);
      if (finalStatus.whisper.ok && finalStatus.node.ok && finalStatus.geminiCli.ok) {
        setModalStatus('Setup complete. Next, sign in with Google in the Trade Mode section.');
        setTimeout(() => { setupModalEl.style.display = 'none'; }, 1200);
      } else {
        setModalStatus('Some items still need attention. Use the setup checklist below for details.');
      }
    }
  } finally {
    btnSetupNext.disabled = false;
    btnSetupSkip.disabled = false;
    btnSetupNext.textContent = 'Next';
  }
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
      const deps = await api.checkDependencies({ geminiCliCommand: editedGeminiCliCommand || 'gemini' });
      if (!deps.geminiCli.ok) {
        await refreshDependencyStatus();
        btnCancel.style.display = 'none';
        btnIn.disabled = false;
        btnOut.disabled = false;
        statusEl.textContent = 'Gemini CLI is not installed yet. Use Install Gemini CLI in the setup checklist first, or switch LLM backend to API mode.';
        statusEl.style.color = 'var(--danger, #ef4444)';
        return;
      }
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
    setUpdateFooterChecking(info.version);
    const update = await api.checkForUpdates();
    setUpdateFooterFromResult(info.version, update);
  } catch {
    setUpdateFooterUnavailable();
  }
}

function setUpdateFooterChecking(version?: string): void {
  versionLabelEl.textContent = version ? `Version: ${version} · Checking...` : 'Checking for updates...';
  versionLabelEl.classList.remove('can-install', 'can-retry');
  versionLabelEl.disabled = true;
  versionLabelEl.title = '';
}

function setUpdateFooterUnavailable(version?: string): void {
  versionLabelEl.textContent = version
    ? `Version: ${version} · Update check unavailable`
    : 'Update check unavailable';
  versionLabelEl.classList.remove('can-install');
  versionLabelEl.classList.add('can-retry');
  versionLabelEl.disabled = false;
  versionLabelEl.title = 'Click to check again';
}

function setUpdateFooterFromResult(
  installedVersion: string,
  update: Awaited<ReturnType<typeof api.checkForUpdates>>
): void {
  if (!update.ok) {
    setUpdateFooterUnavailable(installedVersion);
    return;
  }
  if (update.updateAvailable && update.latestVersion) {
    versionLabelEl.textContent = `Version: ${installedVersion} · ${update.latestVersion} available - click here to install`;
    versionLabelEl.classList.add('can-install');
    versionLabelEl.classList.remove('can-retry');
    versionLabelEl.disabled = false;
    versionLabelEl.title = update.installerAssetUrl
      ? `Download and install Snipalot ${update.latestVersion}`
      : 'Open the latest Snipalot release page';
    return;
  }
  versionLabelEl.textContent = `Version: ${installedVersion} · Up to date`;
  versionLabelEl.classList.remove('can-install', 'can-retry');
  versionLabelEl.disabled = true;
  versionLabelEl.title = '';
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
 * letter keys to upper-case (so Ctrl+Alt+S, not Ctrl+Alt+s) and
 * passes through named keys (Enter, Tab, F1, ArrowUp). Returns empty
 * string for keys we don't accept (modifier-only events get filtered
 * earlier).
 */
function normalizeKey(key: string, code: string): string {
  if (key === ' ') return 'Space';
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

function isValidHotkeyCombo(combo: string): boolean {
  const trimmed = combo.trim();
  if (!trimmed || trimmed !== combo) return false;
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => !part)) return false;
  const main = parts[parts.length - 1];
  if (['Ctrl', 'Control', 'Shift', 'Alt', 'Meta'].includes(main)) return false;
  return parts.slice(0, -1).some((part) => ['Ctrl', 'Control', 'Shift', 'Alt', 'Meta'].includes(part));
}

function isLocalOnlyUndoHotkey(combo: string): boolean {
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => (part === 'ctrl' ? 'control' : part));
  return parts.length === 2 && parts.includes('control') && parts.includes('z');
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
    el.classList.toggle('local-only', key === 'undo' && !!v && isLocalOnlyUndoHotkey(v));
  }
  const undoHotkey = editedHotkeys.undo ?? '';
  if (isLocalOnlyUndoHotkey(undoHotkey)) {
    hotkeySafetyWarningEl.style.display = 'block';
    hotkeySafetyWarningEl.textContent =
      'Undo is set to Ctrl+Z. Snipalot treats this as local-only so it works in Snipalot annotation windows but will not block Undo in Word, Excel, Notepad, or other apps. Use Ctrl+Alt+Z if you need a global recording undo shortcut.';
  } else {
    hotkeySafetyWarningEl.style.display = 'none';
    hotkeySafetyWarningEl.textContent = '';
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
  const cliModel = editedGeminiCliModel.trim() || 'gemini-3.1-pro-preview';

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
  const stopProgress = api.onUpdateDownloadProgress(showDownloadProgress);
  hideDownloadProgress();
  setStatus('Checking for updates…');
  try {
    const info = await api.getAppInfo();
    setUpdateFooterChecking(info.version);
    const result = await api.checkForUpdates();
    setUpdateFooterFromResult(info.version, result);
    if (!result.ok) {
      setStatus(`Update check failed: ${result.message}`, true);
      return;
    }
    if (!result.updateAvailable || !result.latestVersion || !result.releaseUrl) {
      setStatus(`Up to date (${info.version})`);
      return;
    }
    if (!result.installerAssetUrl) {
      setStatus(`Update available: ${result.latestVersion}, but no installer asset was found. Opening release page…`);
      await api.openLatestRelease();
      return;
    }
    const okToInstall = window.confirm(
      `Snipalot ${result.latestVersion} is available.\n\nDownload the installer now, close Snipalot, and start the upgrade?\n\nIf Windows SmartScreen appears, choose More info, then Run anyway. Snipalot cannot click those buttons for you.`
    );
    if (!okToInstall) {
      setStatus(`Update available: ${result.latestVersion}. Install canceled.`);
      setUpdateFooterFromResult(info.version, result);
      return;
    }
    setStatus(`Downloading Snipalot ${result.latestVersion} installer. If SmartScreen appears, choose More info, then Run anyway.`);
    setUpdateFooterChecking(info.version);
    const install = await api.downloadAndInstallUpdate();
    if (!install.ok) {
      setStatus(install.message, true);
      setUpdateFooterFromResult(info.version, result);
      if (install.releaseUrl) await api.openUrl(install.releaseUrl);
      return;
    }
    setStatus(install.message);
  } catch (err) {
    setStatus(`Update check failed: ${(err as Error).message}`, true);
    setUpdateFooterUnavailable();
  } finally {
    stopProgress();
    hideDownloadProgress();
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
  // Bail early if any binding is empty/invalid — the global shortcut layer
  // can't register a malformed accelerator and we'd silently lose the action.
  for (const [key, combo] of Object.entries(editedHotkeys)) {
    if (!isValidHotkeyCombo(combo)) {
      setStatus(`Hotkey for "${HOTKEY_LABELS[key]}" must include a modifier and a key.`, true);
      return;
    }
  }
  if (!editedVisibleActions.record && !editedVisibleActions.screenshot && !editedVisibleActions.trade) {
    setStatus('Show at least one launcher button.', true);
    return;
  }
  btnSave.disabled = true;
  setStatus('Saving…');
  try {
    await api.save({
      outputDir: dir,
      firstRun: false,
      hotkeys: editedHotkeys as never,
      launcher: { visibleActions: editedVisibleActions } as never,
      snapshot: { clearAnnotationsAfter: editedSnapClearAfter } as never,
      feedback: editedFeedbackOutputs as never,
      capture: { countdownSec: editedCountdownSec } as never,
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
  settingsStatusTextEl.textContent = msg;
  settingsStatusEl.className = 'status' + (isError ? ' err' : msg ? ' ok' : '');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function hideDownloadProgress(): void {
  downloadProgressEl.hidden = true;
  downloadProgressFillEl.style.width = '0%';
}

function showDownloadProgress(progress: {
  version: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}): void {
  downloadProgressEl.hidden = false;
  const percent = progress.percent ?? (
    progress.totalBytes ? Math.round((progress.downloadedBytes / progress.totalBytes) * 100) : null
  );
  downloadProgressFillEl.style.width = `${Math.max(0, Math.min(100, percent ?? 8))}%`;
  const sizeText = progress.totalBytes
    ? `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}`
    : formatBytes(progress.downloadedBytes);
  setStatus(
    percent === null
      ? `Downloading Snipalot ${progress.version} installer... ${sizeText}`
      : `Downloading Snipalot ${progress.version} installer... ${percent}% (${sizeText})`
  );
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

// ─── boot ──────────────────────────────────────────────────────────────

init().catch((err) => {
  api.log('settings', 'init error', String(err));
  setStatus('Failed to load settings.', true);
});
