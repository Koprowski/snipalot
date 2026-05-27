import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';

const installer = fs.readFileSync('resources/installer.nsh', 'utf-8');
const mainProcess = fs.readFileSync('src/main/index.ts', 'utf-8');
const lightBuilderConfig = fs.readFileSync('electron-builder.yml', 'utf-8');
const fullBuilderConfig = fs.readFileSync('electron-builder.full.yml', 'utf-8');

function macroBody(name) {
  const pattern = new RegExp(`!macro ${name}([\\s\\S]*?)!macroend`);
  const match = installer.match(pattern);
  assert.ok(match, `missing ${name}`);
  return match[1];
}

test('installer removes stale per-user Electron shortcut identities before recreating Snipalot shortcut', () => {
  const body = macroBody('customInstall');
  assert.match(
    body,
    /SetShellVarContext current[\s\S]*Delete "\$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Snipalot\.lnk"[\s\S]*Delete "\$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Electron\.lnk"[\s\S]*Delete "\$QUICKLAUNCH\\User Pinned\\TaskBar\\Electron\.lnk"[\s\S]*CreateShortCut "\$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Snipalot\.lnk"[\s\S]*!ifdef INSTALL_MODE_PER_ALL_USERS[\s\S]*SetShellVarContext all[\s\S]*Delete "\$SMPROGRAMS\\Snipalot\.lnk"[\s\S]*Delete "\$SMPROGRAMS\\Electron\.lnk"[\s\S]*CreateShortCut "\$SMPROGRAMS\\Snipalot\.lnk"/
  );
});

test('electron-builder Start Menu shortcut path is disabled in favor of custom NSIS shortcuts', () => {
  assert.match(lightBuilderConfig, /createStartMenuShortcut:\s*false/);
  assert.match(fullBuilderConfig, /createStartMenuShortcut:\s*false/);
});

test('uninstaller removes stale Electron shortcuts alongside Snipalot shortcuts', () => {
  const body = macroBody('customUnInstall');
  assert.match(
    body,
    /SetShellVarContext current[\s\S]*Delete "\$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Snipalot\.lnk"[\s\S]*Delete "\$APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Electron\.lnk"[\s\S]*Delete "\$QUICKLAUNCH\\User Pinned\\TaskBar\\Snipalot\.lnk"[\s\S]*Delete "\$QUICKLAUNCH\\User Pinned\\TaskBar\\Electron\.lnk"[\s\S]*SetShellVarContext all[\s\S]*Delete "\$SMPROGRAMS\\Electron\.lnk"[\s\S]*Delete "\$SMPROGRAMS\\Snipalot\.lnk"/
  );
});

test('dev and packaged Windows AppUserModelIDs stay separated', () => {
  assert.match(mainProcess, /const appUserModelId = app\.isPackaged \? 'app\.snipalot' : 'app\.snipalot\.dev';/);
  assert.match(mainProcess, /app\.setAppUserModelId\(appUserModelId\);/);
});
