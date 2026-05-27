import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const lightConfig = fs.readFileSync('electron-builder.yml', 'utf-8');
const fullConfig = fs.readFileSync('electron-builder.full.yml', 'utf-8');

test('release packaging keeps executable icon resource editing enabled', () => {
  assert.doesNotMatch(lightConfig, /signAndEditExecutable:\s*false/);
  assert.doesNotMatch(fullConfig, /signAndEditExecutable:\s*false/);
});

test('normal package scripts assert the embedded Windows executable icon', () => {
  for (const name of ['package', 'package:nopublish', 'package:portable', 'package:full', 'package:full:nopublish']) {
    assert.match(packageJson.scripts[name], /assert-windows-icon/, `${name} should run assert-windows-icon`);
  }
});

test('unsafe no-icon-edit package path is explicit and not used by release scripts', () => {
  assert.match(packageJson.scripts['package:unsafe-no-icon-edit'], /signAndEditExecutable=false/);
  assert.doesNotMatch(packageJson.scripts.package, /signAndEditExecutable=false/);
  assert.doesNotMatch(packageJson.scripts['package:nopublish'], /signAndEditExecutable=false/);
});
