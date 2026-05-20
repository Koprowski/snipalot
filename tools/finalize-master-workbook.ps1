param(
  [string]$CapturesRoot = "",
  [string]$MasterPath = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $CapturesRoot) {
  $CapturesRoot = Split-Path -Parent $scriptDir
}

function Resolve-MasterPath([string]$Root, [string]$RequestedMaster) {
  if ($RequestedMaster) {
    return [System.IO.Path]::GetFullPath($RequestedMaster)
  }
  if ($env:SNIPALOT_MASTER_TRADING_LOG) {
    return [System.IO.Path]::GetFullPath($env:SNIPALOT_MASTER_TRADING_LOG)
  }

  $statementsMaster = Join-Path (Join-Path $Root "Statements") "master trading log.xlsx"
  if (Test-Path -LiteralPath $statementsMaster) {
    return $statementsMaster
  }
  return Join-Path $Root "master trading log.xlsx"
}

$masterPath = Resolve-MasterPath $CapturesRoot $MasterPath
if (-not (Test-Path -LiteralPath $masterPath)) {
  throw "Master workbook not found: $masterPath"
}

$xlUp = -4162
$excel = $null
$workbook = $null

function Release-ComObjectQuietly($object) {
  if ($null -ne $object) {
    try {
      [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($object)
    } catch {
      # Some Excel calls return plain .NET values; only COM RCWs need release.
    }
  }
}

function Set-FormulaDown($sheet, [string]$column, [int]$firstRow, [int]$lastRow, [string]$formula) {
  if ($lastRow -lt $firstRow) { return }
  $topCell = $sheet.Range("${column}${firstRow}")
  Invoke-ExcelRetry { $topCell.Formula2 = $formula } | Out-Null
  if ($lastRow -gt $firstRow) {
    Invoke-ExcelRetry { $sheet.Range("${column}${firstRow}:${column}${lastRow}").FillDown() } | Out-Null
  }
}

function Invoke-ExcelRetry([scriptblock]$Action) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    try {
      return & $Action
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
  throw $lastError
}

function Get-LastNonBlankRow($sheet, [string]$column, [int]$firstRow, [int]$lastRow) {
  for ($row = $lastRow; $row -ge $firstRow; $row--) {
    $value = $sheet.Range("${column}${row}").Value2
    if ($null -ne $value -and "$value" -ne "") {
      return $row
    }
  }
  return $firstRow
}

function Set-CategoryAxis($chart) {
  $xlCategory = 1
  $xlPrimary = 1
  $xlSecondary = 2
  $xlCategoryScale = 2
  try { $chart.Axes($xlCategory, $xlPrimary).CategoryType = $xlCategoryScale } catch {}
  try { $chart.Axes($xlCategory, $xlSecondary).CategoryType = $xlCategoryScale } catch {}
}

function Set-SeriesRanges($chart, $analysisSheet, [string]$xColumn, [string[]]$valueColumns, [int]$firstRow, [int]$lastRow) {
  $series = $chart.SeriesCollection()
  $max = [Math]::Min($series.Count, $valueColumns.Count)
  for ($i = 1; $i -le $max; $i++) {
    $valueColumn = $valueColumns[$i - 1]
    Invoke-ExcelRetry {
      $series.Item($i).XValues = $analysisSheet.Range("${xColumn}${firstRow}:${xColumn}${lastRow}")
      $series.Item($i).Values = $analysisSheet.Range("${valueColumn}${firstRow}:${valueColumn}${lastRow}")
    } | Out-Null
  }
}

function Set-SeriesRangesByName($chart, $analysisSheet, [string]$xColumn, [hashtable]$seriesMap, [int]$firstRow, [int]$lastRow) {
  $series = $chart.SeriesCollection()
  for ($i = 1; $i -le $series.Count; $i++) {
    $item = $series.Item($i)
    $name = ""
    try { $name = [string]$item.Name } catch {}
    if (-not $seriesMap.ContainsKey($name)) { continue }
    $valueColumn = $seriesMap[$name]
    Invoke-ExcelRetry {
      $item.XValues = $analysisSheet.Range("${xColumn}${firstRow}:${xColumn}${lastRow}")
      $item.Values = $analysisSheet.Range("${valueColumn}${firstRow}:${valueColumn}${lastRow}")
    } | Out-Null
  }
}

function Set-FirstSeriesRange($chart, $analysisSheet, [string]$xColumn, [string]$valueColumn, [int]$firstRow, [int]$lastRow) {
  $series = $chart.SeriesCollection()
  if ($series.Count -lt 1) { return }
  Invoke-ExcelRetry {
    $series.Item(1).XValues = $analysisSheet.Range("${xColumn}${firstRow}:${xColumn}${lastRow}")
    $series.Item(1).Values = $analysisSheet.Range("${valueColumn}${firstRow}:${valueColumn}${lastRow}")
  } | Out-Null
}

function Refresh-TradeCharts($workbook, $analysisSheet, [int]$lastMasterRow) {
  $chartsSheet = $workbook.Worksheets.Item("Charts")
  foreach ($chartObject in $chartsSheet.ChartObjects()) {
    $chart = $chartObject.Chart
    $title = ""
    try {
      if ($chart.HasTitle) { $title = $chart.ChartTitle.Text }
    } catch {}

    if ($title -eq "Cumulative P&L (SOL)") {
      Set-CategoryAxis $chart
      Set-FirstSeriesRange $chart $analysisSheet "A" "O" 2 $lastMasterRow
    } elseif ($title -like "P&L % per Trade*") {
      Set-CategoryAxis $chart
      Set-FirstSeriesRange $chart $analysisSheet "AK" "AQ" 2 $lastMasterRow
    } elseif ($title -eq "Entry Market Cap vs P&L %") {
      Set-FirstSeriesRange $chart $analysisSheet "AP" "AQ" 2 $lastMasterRow
    } elseif ($title -eq "Hold Time vs P&L %") {
      Set-FirstSeriesRange $chart $analysisSheet "AR" "AQ" 2 $lastMasterRow
    }
  }
}

function Refresh-DailyCharts($workbook, $analysisSheet, [int]$dailyLastRow) {
  $chartsSheet = $workbook.Worksheets.Item("Charts")
  foreach ($chartObject in $chartsSheet.ChartObjects()) {
    $chart = $chartObject.Chart
    $title = ""
    try {
      if ($chart.HasTitle) { $title = $chart.ChartTitle.Text }
    } catch {}

    if ($title -like "Daily Equity % Change*") {
      Set-CategoryAxis $chart
      Set-SeriesRanges $chart $analysisSheet "AC" @("AD", "AE", "AF") 2 $dailyLastRow
    } elseif ($title -like "Cumulative P&L (SOL) by Day*") {
      Set-CategoryAxis $chart
      Set-SeriesRangesByName $chart $analysisSheet "W" @{
        "Open" = "X"
        "High" = "Y"
        "Low" = "Z"
        "Close" = "AA"
        "Up Vol" = "AH"
        "Down Vol" = "AI"
      } 2 $dailyLastRow
    }
  }
}

try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.EnableEvents = $false
  $excel.ScreenUpdating = $false

  $workbook = Invoke-ExcelRetry { $excel.Workbooks.Open($masterPath) }
  Invoke-ExcelRetry { $excel.Calculation = -4135 } | Out-Null
  $master = $workbook.Worksheets.Item("Master Trading Log")
  $analysis = $workbook.Worksheets.Item("Analysis")

  $lastMasterRow = [Math]::Max(
    $master.Cells($master.Rows.Count, 1).End($xlUp).Row,
    $master.Cells($master.Rows.Count, 7).End($xlUp).Row
  )
  if ($lastMasterRow -lt 2) {
    $lastMasterRow = 2
  }
  $helperLastRow = [Math]::Max($lastMasterRow, 500)

  $tblTrades = $master.ListObjects.Item("tblTrades")
  Invoke-ExcelRetry { $tblTrades.Resize($master.Range("A1:BC$lastMasterRow")) } | Out-Null

  $tblAnalysis = $analysis.ListObjects.Item("tblAnalysis")
  Invoke-ExcelRetry { $tblAnalysis.Resize($analysis.Range("A1:O$lastMasterRow")) } | Out-Null

  $master.Range("G2:G$lastMasterRow").NumberFormat = "m/d/yy"
  $master.Range("AK2:AK$lastMasterRow").NumberFormat = "0"
  $master.Range("AM2:AM$lastMasterRow").NumberFormat = "0"
  $master.Range("AO2:AO$lastMasterRow").NumberFormat = "0"
  $master.Range("AQ2:AQ$lastMasterRow").NumberFormat = "0"
  $master.Range("AS2:AS$lastMasterRow").NumberFormat = "0"
  $master.Range("AZ2:AZ$lastMasterRow").NumberFormat = "0"
  $master.Range("BA2:BB$lastMasterRow").NumberFormat = "0.0""%"""

  Invoke-ExcelRetry { $analysis.Range("A2:O$lastMasterRow").ClearContents() } | Out-Null
  Set-FormulaDown $analysis "A" 2 $lastMasterRow '=ROW()-1'
  Set-FormulaDown $analysis "B" 2 $lastMasterRow '=INDEX(tblTrades[token_name],ROW()-1)'
  Set-FormulaDown $analysis "C" 2 $lastMasterRow '=INDEX(tblTrades[trade_date],ROW()-1)'
  Set-FormulaDown $analysis "D" 2 $lastMasterRow '=INDEX(tblTrades[entry_mc_actual],ROW()-1)'
  Set-FormulaDown $analysis "E" 2 $lastMasterRow '=INDEX(tblTrades[exit_mc_actual],ROW()-1)'
  Set-FormulaDown $analysis "F" 2 $lastMasterRow '=INDEX(tblTrades[time_in_trade_seconds],ROW()-1)'
  Set-FormulaDown $analysis "G" 2 $lastMasterRow '=IFERROR(INDEX(tblTrades[pnl_percentage],ROW()-1)*1,"")'
  Set-FormulaDown $analysis "H" 2 $lastMasterRow '=IFERROR(INDEX(tblTrades[pnl_sol],ROW()-1)*1,"")'
  Set-FormulaDown $analysis "I" 2 $lastMasterRow '=IF(ISNUMBER(G2),IF(G2>0,1,0),"")'
  Set-FormulaDown $analysis "J" 2 $lastMasterRow '=IF(ISNUMBER(D2),IF(D2<2000,"Under 2K",IF(D2<5000,"2-5K",IF(D2<10000,"5-10K",IF(D2<20000,"10-20K","20K+")))),"")'
  Set-FormulaDown $analysis "K" 2 $lastMasterRow '=IF(ISNUMBER(F2),IF(F2=0,"Unknown (0s)",IF(F2<=15,"1-15s",IF(F2<=45,"15-45s",IF(F2<=90,"45-90s","90s+")))),"")'
  Set-FormulaDown $analysis "L" 2 $lastMasterRow '=IFERROR(INDEX(tblTrades[sol_invested],ROW()-1),"")'
  Set-FormulaDown $analysis "M" 2 $lastMasterRow '=COUNTIFS(tblAnalysis[Token],tblAnalysis[[#This Row],[Token]])'
  Set-FormulaDown $analysis "N" 2 $lastMasterRow '=COUNTIFS($B$2:B2,tblAnalysis[[#This Row],[Token]])'
  Set-FormulaDown $analysis "O" 2 $lastMasterRow '=IFERROR(SUM($H$2:H2),"")'

  Invoke-ExcelRetry { $analysis.Range("Q2:Q$helperLastRow").ClearContents() } | Out-Null
  Invoke-ExcelRetry { $analysis.Range("Q2").Formula2 = '=IFERROR(SORT(UNIQUE(FILTER(tblAnalysis[Date],tblAnalysis[Date]<>""))),"")' } | Out-Null

  foreach ($column in @("R","S","T","U","W","X","Y","Z","AA","AC","AD","AE","AF","AH","AI","AK","AL","AM","AN","AP","AQ","AR","AS","BF","BG","BH")) {
    Invoke-ExcelRetry { $analysis.Range("${column}2:${column}$helperLastRow").ClearContents() } | Out-Null
  }

  Set-FormulaDown $analysis "R" 2 $helperLastRow '=IF(Q2="","",SUMIFS(tblAnalysis[P&L SOL],tblAnalysis[Date],Q2))'
  Set-FormulaDown $analysis "S" 2 $helperLastRow '=IF(Q2="","",SUMIFS(tblAnalysis[P&L %],tblAnalysis[Date],Q2))'
  Set-FormulaDown $analysis "T" 2 $helperLastRow '=IF(Q2="","",IFERROR(SUM($R$2:R2),""))'
  Set-FormulaDown $analysis "U" 2 $helperLastRow '=IF(Q2="","",COUNTIFS(tblAnalysis[Date],Q2))'
  Set-FormulaDown $analysis "W" 2 $helperLastRow '=IF(Q2="","",Q2)'
  Set-FormulaDown $analysis "X" 2 $helperLastRow '=IF(Q2="","",IF(ROW()=2,0,AA1))'
  Set-FormulaDown $analysis "Y" 2 $helperLastRow '=IF(Q2="","",MAX(X2,MAXIFS(tblAnalysis[Cum P&L SOL],tblAnalysis[Date],Q2)))'
  Set-FormulaDown $analysis "Z" 2 $helperLastRow '=IF(Q2="","",MIN(X2,MINIFS(tblAnalysis[Cum P&L SOL],tblAnalysis[Date],Q2)))'
  Set-FormulaDown $analysis "AA" 2 $helperLastRow '=IF(Q2="","",T2)'
  Set-FormulaDown $analysis "AC" 2 $helperLastRow '=IF(Q2="","",Q2)'
  Set-FormulaDown $analysis "AD" 2 $helperLastRow '=IF(Q2="","",(Y2-X2)/$BK$1)'
  Set-FormulaDown $analysis "AE" 2 $helperLastRow '=IF(Q2="","",(Z2-X2)/$BK$1)'
  Set-FormulaDown $analysis "AF" 2 $helperLastRow '=IF(Q2="","",(AA2-X2)/$BK$1)'
  Set-FormulaDown $analysis "AH" 2 $helperLastRow '=IF(Q2="","",IF(AA2>=X2,U2,0))'
  Set-FormulaDown $analysis "AI" 2 $helperLastRow '=IF(Q2="","",IF(AA2<X2,U2,0))'
  Set-FormulaDown $analysis "AK" 2 $helperLastRow '=IFERROR(IF(INDEX($A:$A,ROW())="","",INDEX($A:$A,ROW())),"")'
  Set-FormulaDown $analysis "AL" 2 $helperLastRow '=IFERROR(INDEX(tblTrades[sol_invested],ROW()-1),"")'
  Set-FormulaDown $analysis "AM" 2 $helperLastRow '=IFERROR(INDEX(tblAnalysis[P&L SOL],ROW()-1),"")'
  Set-FormulaDown $analysis "AN" 2 $helperLastRow '=IFERROR(IF(INDEX(tblTrades[sol_invested],ROW()-1)>0.5,INDEX(tblAnalysis[Token],ROW()-1)&" ("&TEXT(INDEX(tblTrades[sol_invested],ROW()-1),"0.0")&" SOL)",""),"")'
  Set-FormulaDown $analysis "AP" 2 $helperLastRow '=IFERROR(INDEX(tblAnalysis[Entry MC ($)],ROW()-1),"")'
  Set-FormulaDown $analysis "AQ" 2 $helperLastRow '=IFERROR(INDEX(tblAnalysis[P&L %],ROW()-1),"")'
  Set-FormulaDown $analysis "AR" 2 $helperLastRow '=IFERROR(INDEX(tblAnalysis[Hold Time (s)],ROW()-1),"")'
  Set-FormulaDown $analysis "AS" 2 $helperLastRow '=IFERROR(INDEX(tblAnalysis[P&L SOL],ROW()-1),"")'
  Set-FormulaDown $analysis "BF" 2 $helperLastRow '=IF(W2="","","("&U2&")")'
  Set-FormulaDown $analysis "BG" 2 $helperLastRow '=IF(W2="","",W2)'
  Set-FormulaDown $analysis "BH" 2 $helperLastRow '=IF(W2="","",-2.5)'

  $analysis.Range("C2:C$lastMasterRow").NumberFormat = "m/d/yy"
  $analysis.Range("Q2:Q$helperLastRow").NumberFormat = "m/d/yy"
  $analysis.Range("W2:W$helperLastRow").NumberFormat = "m/d/yy"
  $analysis.Range("AC2:AC$helperLastRow").NumberFormat = "m/d/yy"
  $analysis.Range("BG2:BG$helperLastRow").NumberFormat = "m/d/yy"

  Invoke-ExcelRetry { $excel.Calculation = -4105 } | Out-Null
  Invoke-ExcelRetry { $master.Calculate() } | Out-Null
  Invoke-ExcelRetry { $analysis.Calculate() } | Out-Null
  Start-Sleep -Milliseconds 500
  $dailyLastRow = Get-LastNonBlankRow $analysis "Q" 2 $helperLastRow
  Refresh-TradeCharts $workbook $analysis $lastMasterRow
  Refresh-DailyCharts $workbook $analysis $dailyLastRow
  Invoke-ExcelRetry { $master.Calculate() } | Out-Null
  Invoke-ExcelRetry { $analysis.Calculate() } | Out-Null
  Start-Sleep -Milliseconds 500
  Invoke-ExcelRetry { $workbook.Save() } | Out-Null

  Write-Host (@{
    master = $masterPath
    lastMasterRow = $lastMasterRow
    helperLastRow = $helperLastRow
    dailyLastRow = $dailyLastRow
    finalized = $true
  } | ConvertTo-Json -Compress)
} finally {
  if ($null -ne $workbook) {
    try { $workbook.Close($false) } catch {}
  }
  if ($null -ne $excel) {
    try { $excel.Quit() } catch {}
  }
  Release-ComObjectQuietly $tblTrades
  Release-ComObjectQuietly $tblAnalysis
  Release-ComObjectQuietly $master
  Release-ComObjectQuietly $analysis
  Release-ComObjectQuietly $workbook
  Release-ComObjectQuietly $excel
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
