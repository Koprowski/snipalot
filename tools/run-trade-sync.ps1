param(
  [string]$CapturesRoot = "",
  [switch]$BackfillArchive,
  [switch]$RepairOnly,
  [switch]$ArchiveOnly,
  [switch]$TestMode,
  [switch]$NoArchive,
  [switch]$ReplaceSourceRows,
  [string]$MasterPath = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$syncScript = Join-Path $scriptDir "sync-master-trading-log.mjs"
$finalizeScript = Join-Path $scriptDir "finalize-master-workbook.ps1"
$node = "C:\Users\kopro\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

function Resolve-DisplayMasterPath([string]$Root, [string]$RequestedMaster) {
  if ($RequestedMaster) {
    return [System.IO.Path]::GetFullPath($RequestedMaster)
  }
  if ($env:SNIPALOT_MASTER_TRADING_LOG) {
    return [System.IO.Path]::GetFullPath($env:SNIPALOT_MASTER_TRADING_LOG)
  }
  $baseRoot = if ($Root) { $Root } else { Split-Path -Parent $scriptDir }
  $statementsMaster = Join-Path (Join-Path $baseRoot "Statements") "master trading log.xlsx"
  if (Test-Path -LiteralPath $statementsMaster) {
    return $statementsMaster
  }
  return Join-Path $baseRoot "master trading log.xlsx"
}

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
  if ($MasterPath) {
    $args += @("--master", $MasterPath)
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
    if ($MasterPath) {
      $finalizeArgs += @("-MasterPath", $MasterPath)
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
if ($ArchiveOnly) {
  $displayRoot = if ($CapturesRoot) { $CapturesRoot } else { "the Snipalot Captures folder" }
  Write-Host "Done. Completed current trade folders have been moved into $displayRoot\Archive."
} else {
  $displayMaster = Resolve-DisplayMasterPath $CapturesRoot $MasterPath
  Write-Host "Done. $displayMaster has been recalculated and saved."
}
