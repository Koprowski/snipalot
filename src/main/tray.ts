/**
 * System tray icon and context menu for Snipalot.
 *
 * The tray gives the user a persistent access point even when the floating
 * launcher is minimized. Call `updateTrayMenu(state)` whenever app state
 * changes to keep the menu in sync.
 */

import { Tray, Menu, nativeImage, app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { log } from './logger';

type AppState = 'idle' | 'selecting' | 'recording' | 'processing';

let tray: Tray | null = null;

interface TrayCallbacks {
  onStartStop: () => void;
  onSettings: () => void;
  onQuit: () => void;
  onShowLauncher: () => void;
}

let _callbacks: TrayCallbacks | null = null;
let _currentState: AppState = 'idle';

export function createTray(callbacks: TrayCallbacks): Tray {
  _callbacks = callbacks;

  // Try to load the 16 px tray icon; fall back to a tiny blank image so the
  // tray doesn't crash on systems where the icon file hasn't been generated yet.
  const iconPath16 = path.join(process.cwd(), 'resources', 'icons', 'app-16.png');
  const iconPath32 = path.join(process.cwd(), 'resources', 'icons', 'app-32.png');
  let icon: Electron.NativeImage;
  if (fs.existsSync(iconPath16)) {
    icon = nativeImage.createFromPath(iconPath16);
  } else if (fs.existsSync(iconPath32)) {
    icon = nativeImage.createFromPath(iconPath32);
  } else {
    // 1×1 transparent fallback so we don't throw.
    icon = nativeImage.createEmpty();
    log('tray', 'icon file not found; using empty placeholder', { iconPath16 });
  }

  tray = new Tray(icon);
  tray.setToolTip('Snipalot');

  // Left-click restores/focuses the launcher on Windows.
  tray.on('click', () => {
    log('tray', 'left-click; showing launcher');
    _callbacks?.onShowLauncher();
  });

  updateTrayMenu('idle');

  log('tray', 'created');
  return tray;
}

export function updateTrayMenu(state: AppState): void {
  if (!tray || tray.isDestroyed()) return;
  _currentState = state;

  const recordLabel =
    state === 'recording' ? 'Stop Recording' :
    state === 'selecting' ? 'Cancel Selection' :
    state === 'processing' ? 'Processing… (please wait)' :
    'Start Recording';

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: recordLabel,
      click: () => _callbacks?.onStartStop(),
    },
    { type: 'separator' },
    {
      label: 'Settings…',
      click: () => _callbacks?.onSettings(),
    },
    { type: 'separator' },
    {
      label: `Quit Snipalot`,
      role: 'quit',
      click: () => _callbacks?.onQuit(),
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  log('tray', 'menu updated', { state });
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}
