param(
  [string]$CapturesRoot = "",
  [switch]$BackfillArchive,
  [switch]$RepairOnly,
  [switch]$ArchiveOnly,
  [switch]$TestMode,
  [switch]$NoArchive,
  [switch]$ReplaceSourceRows
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$syncScript = Join-Path $scriptDir "sync-master-trading-log.mjs"
$finalizeScript = Join-Path $scriptDir "finalize-master-workbook.ps1"
$node = "C:\Users\kopro\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path -LiteralPath $node)) {
  $node = "node"
}

Write-Host "Snipalot trade sync"
if ($ArchiveOnly) {
  Write-Host "Archive-only mode: master trading log.xlsx is not imported, rewritten, or finalized."
} else {
  Write-Host "Close master trading log.xlsx in Excel before running this."
}
Write-Host ""

Push-Location (Split-Path -Parent $scriptDir)
try {
  $args = @($syncScript)
  if ($CapturesRoot) {
    $args += @("--root", $CapturesRoot)
  }
  if ($BackfillArchive) {
    $args += "--backfill-archive"
  }
  if ($RepairOnly) {
    $args += "--repair-only"
  }
  if ($ArchiveOnly) {
    $args += "--archive-only"
  }
  if ($TestMode) {
    $args += "--test-mode"
  }
  if ($NoArchive) {
    $args += "--no-archive"
  }
  if ($ReplaceSourceRows) {
    $args += "--replace-source-rows"
  }
  & $node @args
  if ($LASTEXITCODE -ne 0) {
    throw "Trade sync failed with exit code $LASTEXITCODE."
  }

  if (-not $ArchiveOnly) {
    $finalizeArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $finalizeScript)
    if ($CapturesRoot) {
      $finalizeArgs += @("-CapturesRoot", $CapturesRoot)
    }
    & powershell.exe @finalizeArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Excel workbook finalization failed with exit code $LASTEXITCODE."
    }
  }
} finally {
  Pop-Location
}

Write-Host ""
$displayRoot = if ($CapturesRoot) { $CapturesRoot } else { "the Snipalot Captures folder" }
if ($ArchiveOnly) {
  Write-Host "Done. Completed current trade folders have been moved into $displayRoot\Archive."
} else {
  Write-Host "Done. $displayRoot\master trading log.xlsx has been recalculated and saved."
}
