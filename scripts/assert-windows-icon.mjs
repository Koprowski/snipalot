import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform !== 'win32') {
  console.log('[assert-windows-icon] skipped: Windows-only check');
  process.exit(0);
}

const expectedIcon = join(process.cwd(), 'resources', 'icons', 'app.ico');
const exePath = process.argv[2] || join(process.cwd(), 'release', 'win-unpacked', 'Snipalot.exe');

if (!existsSync(expectedIcon)) {
  console.error(`[assert-windows-icon] missing expected icon: ${expectedIcon}`);
  process.exit(1);
}

if (!existsSync(exePath)) {
  console.error(`[assert-windows-icon] missing packaged executable: ${exePath}`);
  process.exit(1);
}

const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Security

function Get-IconHash([string] $Path) {
  if ($Path.ToLowerInvariant().EndsWith('.ico')) {
    $icon = [System.Drawing.Icon]::new($Path)
  } else {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
  }
  if ($null -eq $icon) {
    throw "No associated icon found for $Path"
  }
  $bitmap = $icon.ToBitmap()
  $stream = [System.IO.MemoryStream]::new()
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [Convert]::ToBase64String($sha.ComputeHash($stream.ToArray()))
  } finally {
    $sha.Dispose()
    $stream.Dispose()
    $bitmap.Dispose()
    $icon.Dispose()
  }
}

$expected = Get-IconHash -Path '${expectedIcon.replaceAll("'", "''")}'
$actual = Get-IconHash -Path '${exePath.replaceAll("'", "''")}'
[Console]::Out.WriteLine(($expected + "|" + $actual))
`;

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
  { encoding: 'utf8' }
);

if (result.status !== 0) {
  console.error('[assert-windows-icon] PowerShell icon extraction failed');
  if (result.stdout.trim()) console.error(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  process.exit(result.status || 1);
}

const [expectedHash, actualHash] = result.stdout.trim().split('|');
if (!expectedHash || !actualHash) {
  console.error(`[assert-windows-icon] unexpected hash output: ${result.stdout.trim()}`);
  process.exit(1);
}

if (expectedHash !== actualHash) {
  console.error('[assert-windows-icon] packaged Snipalot.exe does not embed the Snipalot app icon');
  console.error(`[assert-windows-icon] expected icon: ${expectedIcon}`);
  console.error(`[assert-windows-icon] executable: ${exePath}`);
  console.error('[assert-windows-icon] likely cause: win.signAndEditExecutable is disabled or executable resource editing failed');
  process.exit(1);
}

console.log(`[assert-windows-icon] packaged executable icon matches ${expectedIcon}`);
