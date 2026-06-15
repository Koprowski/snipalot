param(
  [string]$CapturesRoot = "",
  [switch]$BackfillArchive,
  [switch]$RepairOnly,
  [switch]$ArchiveOnly,
  [switch]$TestMode,
  [switch]$NoArchive,
  [switch]$ReplaceSourceRows,
  [string[]]$IncludeSession = @(),
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
  $rootMaster = Join-Path $baseRoot "master trading log.xlsx"
  if (Test-Path -LiteralPath $rootMaster) {
    return $rootMaster
  }
  $statementsMaster = Join-Path (Join-Path $baseRoot "Statements") "master trading log.xlsx"
  if (Test-Path -LiteralPath $statementsMaster) {
    return $statementsMaster
  }
  return $rootMaster
}

function Close-OpenMasterWorkbook([string]$WorkbookPath) {
  if (-not $WorkbookPath -or -not (Test-Path -LiteralPath $WorkbookPath)) {
    return
  }

  $resolvedTarget = [System.IO.Path]::GetFullPath($WorkbookPath)
  try {
    $excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
  } catch {
    return
  }

  foreach ($workbook in @($excel.Workbooks)) {
    $fullName = ""
    try {
      $fullName = [System.IO.Path]::GetFullPath([string]$workbook.FullName)
    } catch {
      continue
    }
    if (-not [string]::Equals($fullName, $resolvedTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    if (-not $workbook.Saved) {
      throw "Master workbook is open in Excel with unsaved changes. Save or close it, then rerun sync: $resolvedTarget"
    }
    Write-Host "Closing open saved master workbook in Excel: $resolvedTarget"
    $workbook.Close($false)
    Start-Sleep -Milliseconds 500
    return
  }
}

function Get-ZeroByteHexScratchFiles([string]$WorkbookPath, [datetime]$StartedAt) {
  if (-not $WorkbookPath) { return @() }
  $masterDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($WorkbookPath))
  if (-not (Test-Path -LiteralPath $masterDir)) { return @() }

  return @(
    Get-ChildItem -LiteralPath $masterDir -Force -File |
      Where-Object {
        $_.Length -eq 0 -and
        $_.Name -match '^[0-9A-Fa-f]{8}$' -and
        $_.CreationTime -ge $StartedAt.AddMinutes(-1)
      }
  )
}

function Remove-ZeroByteHexScratchFiles([string]$WorkbookPath, [datetime]$StartedAt) {
  foreach ($file in Get-ZeroByteHexScratchFiles $WorkbookPath $StartedAt) {
    try {
      Remove-Item -LiteralPath $file.FullName -Force
      Write-Host "Removed orphan Excel scratch file: $($file.FullName)"
    } catch {
      Write-Warning "Could not remove orphan Excel scratch file $($file.FullName): $($_.Exception.Message)"
    }
  }
}

function Quote-ProcessArgument([string]$Argument) {
  if ($Argument -notmatch '[\s"]') {
    return $Argument
  }
  return '"' + ($Argument -replace '"', '\"') + '"'
}

function Invoke-WorkbookFinalizer([object[]]$FinalizeArgs) {
  $maxAttempts = 3
  $timeoutMs = 180000
  $argumentList = @($FinalizeArgs | ForEach-Object { Quote-ProcessArgument ([string]$_) })

  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentList -NoNewWindow -PassThru
    if (-not $process.WaitForExit($timeoutMs)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $exitCode = 124
    } else {
      $process.Refresh()
      $exitCode = if ($null -ne $process.ExitCode) { [int]$process.ExitCode } else { 0 }
    }

    if ($exitCode -eq 0) {
      return
    }

    if ($attempt -lt $maxAttempts) {
      Write-Warning "Excel workbook finalization failed with exit code $exitCode. Retrying finalization in 3 seconds..."
      Start-Sleep -Seconds 3
    }
  }

  throw "Excel workbook finalization failed after $maxAttempts attempts."
}

if (-not (Test-Path -LiteralPath $node)) {
  $node = "node"
}

Write-Host "Snipalot trade sync"
if ($ArchiveOnly) {
  Write-Host "Archive-only mode: master trading log.xlsx is not imported, rewritten, or finalized."
} else {
  Write-Host "Master workbook must be writable. If it is open in Excel and already saved, this script will close it."
}
Write-Host ""

$runStartedAt = Get-Date
$displayMasterBeforeSync = ""
Push-Location (Split-Path -Parent $scriptDir)
try {
  if (-not $ArchiveOnly) {
    $displayMasterBeforeSync = Resolve-DisplayMasterPath $CapturesRoot $MasterPath
    Close-OpenMasterWorkbook $displayMasterBeforeSync
  }

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
  foreach ($session in $IncludeSession) {
    if ($session) {
      $args += @("--include-session", $session)
    }
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
    Invoke-WorkbookFinalizer $finalizeArgs
  }
} finally {
  if (-not $ArchiveOnly -and $displayMasterBeforeSync) {
    Remove-ZeroByteHexScratchFiles $displayMasterBeforeSync $runStartedAt
  }
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
