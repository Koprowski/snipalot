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

function Get-IconBitmap([string] $Path, [int] $Width = 0, [int] $Height = 0) {
  if ($Path.ToLowerInvariant().EndsWith('.ico')) {
    if ($Width -gt 0 -and $Height -gt 0) {
      $icon = [System.Drawing.Icon]::new($Path, [System.Drawing.Size]::new($Width, $Height))
    } else {
      $icon = [System.Drawing.Icon]::new($Path)
    }
  } else {
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
  }
  if ($null -eq $icon) {
    throw "No associated icon found for $Path"
  }
  try {
    return $icon.ToBitmap()
  } finally {
    $icon.Dispose()
  }
}

function Compare-Bitmaps([System.Drawing.Bitmap] $Expected, [System.Drawing.Bitmap] $Actual) {
  if ($Expected.Width -ne $Actual.Width -or $Expected.Height -ne $Actual.Height) {
    throw "Bitmap sizes differ: expected $($Expected.Width)x$($Expected.Height), actual $($Actual.Width)x$($Actual.Height)"
  }
  $total = 0.0
  $maxDelta = 255.0 * 4.0 * $Expected.Width * $Expected.Height
  for ($y = 0; $y -lt $Expected.Height; $y += 1) {
    for ($x = 0; $x -lt $Expected.Width; $x += 1) {
      $e = $Expected.GetPixel($x, $y)
      $a = $Actual.GetPixel($x, $y)
      $total += [Math]::Abs([int]$e.A - [int]$a.A)
      $total += [Math]::Abs([int]$e.R - [int]$a.R)
      $total += [Math]::Abs([int]$e.G - [int]$a.G)
      $total += [Math]::Abs([int]$e.B - [int]$a.B)
    }
  }
  $similarity = 1.0 - ($total / $maxDelta)
  return [Math]::Round($similarity, 6)
}

$actualBitmap = Get-IconBitmap -Path '${exePath.replaceAll("'", "''")}'
$expectedBitmap = Get-IconBitmap -Path '${expectedIcon.replaceAll("'", "''")}' -Width $actualBitmap.Width -Height $actualBitmap.Height
try {
  $similarity = Compare-Bitmaps -Expected $expectedBitmap -Actual $actualBitmap
  [Console]::Out.WriteLine(($similarity.ToString([System.Globalization.CultureInfo]::InvariantCulture) + "|" + $actualBitmap.Width + "x" + $actualBitmap.Height))
} finally {
  $expectedBitmap.Dispose()
  $actualBitmap.Dispose()
}
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

const [similarityText, actualSize] = result.stdout.trim().split('|');
const similarity = Number(similarityText);
if (!Number.isFinite(similarity)) {
  console.error(`[assert-windows-icon] unexpected similarity output: ${result.stdout.trim()}`);
  process.exit(1);
}

if (similarity < 0.9) {
  console.error('[assert-windows-icon] packaged Snipalot.exe icon is not similar enough to the Snipalot app icon');
  console.error(`[assert-windows-icon] expected icon: ${expectedIcon}`);
  console.error(`[assert-windows-icon] executable: ${exePath}`);
  if (actualSize) console.error(`[assert-windows-icon] compared icon size: ${actualSize}`);
  console.error(`[assert-windows-icon] pixel similarity: ${similarity.toFixed(4)}`);
  console.error('[assert-windows-icon] likely cause: win.signAndEditExecutable is disabled or executable resource editing failed');
  process.exit(1);
}

console.log(`[assert-windows-icon] packaged executable icon matches ${expectedIcon} (similarity ${similarity.toFixed(4)})`);
