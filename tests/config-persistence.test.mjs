import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('saveConfig persists successful writes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snipalot-config-ok-'));
  const code = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const config = require(${JSON.stringify(path.resolve('dist/main/config.js'))});
    const outputDir = path.join(process.env.USERPROFILE, 'Recordings');
    config.saveConfig({ outputDir });
    const written = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.snipalot', 'config.json'), 'utf-8'));
    assert.equal(written.outputDir, outputDir);
    assert.equal(config.getConfig().outputDir, outputDir);
  `;
  runConfigChild(home, code);
});

test('saveConfig throws and leaves memory unchanged when disk write fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snipalot-config-fail-'));
  fs.writeFileSync(path.join(home, '.snipalot'), 'not a directory');
  const code = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const config = require(${JSON.stringify(path.resolve('dist/main/config.js'))});
    const before = config.getConfig().outputDir;
    assert.throws(
      () => config.saveConfig({ outputDir: path.join(process.env.USERPROFILE, 'ShouldNotStick') }),
      /ENOTDIR|not a directory|no such file/i
    );
    assert.equal(config.getConfig().outputDir, before);
  `;
  runConfigChild(home, code);
});

test('loadConfig migrates old default trade marker hotkey', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snipalot-config-migrate-'));
  const configDir = path.join(home, '.snipalot');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ hotkeys: { tradeMarker: 'Ctrl+Shift+M' } }),
    'utf-8'
  );
  const code = `
    const assert = require('node:assert/strict');
    const config = require(${JSON.stringify(path.resolve('dist/main/config.js'))});
    const loaded = config.loadConfig();
    assert.equal(loaded.hotkeys.tradeMarker, 'Ctrl+Shift+X');
  `;
  runConfigChild(home, code);
});

test('loadConfig preserves custom trade marker hotkey', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snipalot-config-custom-hotkey-'));
  const configDir = path.join(home, '.snipalot');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ hotkeys: { tradeMarker: 'Ctrl+Alt+X' } }),
    'utf-8'
  );
  const code = `
    const assert = require('node:assert/strict');
    const config = require(${JSON.stringify(path.resolve('dist/main/config.js'))});
    const loaded = config.loadConfig();
    assert.equal(loaded.hotkeys.tradeMarker, 'Ctrl+Alt+X');
  `;
  runConfigChild(home, code);
});

test('loadConfig accepts UTF-8 BOM config files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snipalot-config-bom-'));
  const configDir = path.join(home, '.snipalot');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    `\uFEFF${JSON.stringify({ capture: { mode: 'fullscreen', countdownSec: 0 } })}`,
    'utf-8'
  );
  const code = `
    const assert = require('node:assert/strict');
    const config = require(${JSON.stringify(path.resolve('dist/main/config.js'))});
    const loaded = config.loadConfig();
    assert.equal(loaded.capture.mode, 'fullscreen');
    assert.equal(loaded.capture.countdownSec, 0);
  `;
  runConfigChild(home, code);
});

function runConfigChild(home, code) {
  const result = spawnSync(process.execPath, ['-e', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
    },
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
