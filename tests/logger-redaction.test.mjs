import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('logger rotates large files and redacts common API keys and auth tokens', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snipalot-logger-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmp);
  try {
    const logDir = path.join(tmp, 'spike-output');
    fs.mkdirSync(logDir, { recursive: true });
    const oversizedLog = path.join(logDir, 'snipalot.log');
    fs.writeFileSync(oversizedLog, 'x'.repeat(5 * 1024 * 1024 + 1));

    const mod = await import('../dist/main/logger.js');
    mod.log('test', {
      openaiApiKey: 'sk-or-' + 'a'.repeat(48),
      geminiApiKey: 'AIza' + 'b'.repeat(36),
      nested: { Authorization: 'Bearer sk-' + 'c'.repeat(40) },
      password: 'correct-horse-battery-staple',
    });

    const logPath = mod.getLogPath();
    assert.ok(logPath);
    assert.ok(fs.existsSync(`${logPath}.1`));
    assert.ok(fs.statSync(logPath).size < fs.statSync(`${logPath}.1`).size);
    const text = fs.readFileSync(logPath, 'utf-8');
    assert.match(text, /\[REDACTED/);
    assert.doesNotMatch(text, /sk-or-a/);
    assert.doesNotMatch(text, /AIza/);
    assert.doesNotMatch(text, /sk-c/);
    assert.doesNotMatch(text, /correct-horse-battery-staple/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
