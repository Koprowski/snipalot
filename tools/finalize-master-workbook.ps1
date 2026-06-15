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

  $rootMaster = Join-Path $Root "master trading log.xlsx"
  if (Test-Path -LiteralPath $rootMaster) {
    return $rootMaster
  }
  $statementsMaster = Join-Path (Join-Path $Root "Statements") "master trading log.xlsx"
  if (Test-Path -LiteralPath $statementsMaster) {
    return $statementsMaster
  }
  return $rootMaster
}

$masterPath = Resolve-MasterPath $CapturesRoot $MasterPath
if (-not (Test-Path -LiteralPath $masterPath)) {
  throw "Master workbook not found: $masterPath"
}

$xlUp = -4162
$xlToLeft = -4159
$excel = $null
$workbook = $null
$script:finalizerWarnings = New-Object System.Collections.Generic.List[string]

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

function Set-FormulaR1C1Down($sheet, [int]$column, [int]$firstRow, [int]$lastRow, [string]$formulaR1C1) {
  if ($lastRow -lt $firstRow) { return }
  if (-not $formulaR1C1 -or -not $formulaR1C1.StartsWith("=")) { return }
  Invoke-ExcelRetry {
    $sheet.Range($sheet.Cells($firstRow, $column), $sheet.Cells($lastRow, $column)).FormulaR1C1 = $formulaR1C1
  } | Out-Null
}

function Fill-MasterCalculatedColumns($masterSheet, [int]$firstCalculatedColumn, [int]$lastCalculatedColumn, [int]$lastRow) {
  if ($lastRow -lt 2 -or $lastCalculatedColumn -lt $firstCalculatedColumn) { return }
  $formulaHeaders = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  @(
    "ohlc_pct_high",
    "ohlc_pct_low",
    "ohlc_pct_close",
    "is_new_cluster_start",
    "prior_cluster_id",
    "prior_cluster_last_exit_dt",
    "this_trade_entry_dt",
    "cooldown_minutes",
    "prior_cluster_outcome",
    "cooldown_bucket",
    "cluster_group_id",
    "cluster_total_pnl_sol",
    "cluster_avg_pnl_pct",
    "cluster_win",
    "trade_num_in_session"
  ) | ForEach-Object { [void]$formulaHeaders.Add($_) }
  for ($column = $firstCalculatedColumn; $column -le $lastCalculatedColumn; $column++) {
    $header = Invoke-ExcelRetry { [string]$masterSheet.Cells(1, $column).Value2 }
    if (-not $formulaHeaders.Contains($header)) { continue }
    $formulaR1C1 = Invoke-ExcelRetry { [string]$masterSheet.Cells(2, $column).FormulaR1C1 }
    Set-FormulaR1C1Down $masterSheet $column 2 $lastRow $formulaR1C1
  }
}

function Invoke-ExcelRetry([scriptblock]$Action) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    try {
      return & $Action
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds (250 * $attempt)
    }
  }
  throw $lastError
}

function Add-FinalizerWarning([string]$Message) {
  $script:finalizerWarnings.Add($Message) | Out-Null
  Write-Warning $Message
}

function Invoke-ExcelOptional([scriptblock]$Action, [string]$Description) {
  try {
    & $Action
    return $true
  } catch {
    Add-FinalizerWarning "$Description failed: $($_.Exception.Message)"
    return $false
  }
}

function Get-LastNonBlankRow($sheet, [string]$column, [int]$firstRow, [int]$lastRow) {
  for ($row = $lastRow; $row -ge $firstRow; $row--) {
    $value = Invoke-ExcelRetry { $sheet.Range("${column}${row}").Value2 }
    if ($null -ne $value -and "$value" -ne "") {
      return $row
    }
  }
  return $firstRow
}

function Get-DailyLastRowFromMasterDates($masterSheet, [int]$lastMasterRow, [int]$helperLastRow) {
  if ($lastMasterRow -lt 2) { return 2 }
  $dates = New-Object 'System.Collections.Generic.HashSet[string]'
  for ($row = 2; $row -le $lastMasterRow; $row++) {
    $cell = Invoke-ExcelRetry { $masterSheet.Range("G$row") }
    $text = Invoke-ExcelRetry { [string]$cell.Text }
    $value = Invoke-ExcelRetry { $cell.Value2 }
    if ([string]::IsNullOrWhiteSpace($text) -or $null -eq $value -or "$value" -eq "") {
      continue
    }
    [void]$dates.Add([string]$value)
  }
  return [Math]::Max(2, [Math]::Min($helperLastRow, $dates.Count + 1))
}

function Get-ColumnLetter([int]$ColumnNumber) {
  $name = ""
  while ($ColumnNumber -gt 0) {
    $mod = ($ColumnNumber - 1) % 26
    $name = [char](65 + $mod) + $name
    $ColumnNumber = [Math]::Floor(($ColumnNumber - $mod) / 26)
  }
  return $name
}

function Find-HeaderColumn($sheet, [string]$HeaderName, [int]$lastColumn) {
  for ($column = 1; $column -le $lastColumn; $column++) {
    $value = Invoke-ExcelRetry { [string]$sheet.Cells(1, $column).Value2 }
    if ([string]::Equals($value, $HeaderName, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $column
    }
  }
  return 0
}

function Set-MasterFormulaByHeader($sheet, [string]$HeaderName, [int]$lastColumn, [int]$lastRow, [string]$formula) {
  $column = Find-HeaderColumn $sheet $HeaderName $lastColumn
  if ($column -le 0) { return }
  Set-FormulaDown $sheet (Get-ColumnLetter $column) 2 $lastRow $formula
}

function Refresh-CooldownFormulas($masterSheet, [int]$lastColumn, [int]$lastRow) {
  if ($lastRow -lt 2) { return }
  Set-MasterFormulaByHeader $masterSheet "prior_cluster_last_exit_dt" $lastColumn $lastRow '=IF(AND(BP2=1,ROW()>2),G1+IFERROR(TIMEVALUE(L1),0),"")'
  Set-MasterFormulaByHeader $masterSheet "this_trade_entry_dt" $lastColumn $lastRow '=IF(BP2=1,G2+IFERROR(TIMEVALUE(J2),IFERROR(TIMEVALUE(L2)-M2/86400,0)),"")'
  Set-MasterFormulaByHeader $masterSheet "cooldown_minutes" $lastColumn $lastRow '=IF(AND(BP2=1,ISNUMBER(BR2),ISNUMBER(BS2)),(BS2-BR2)*1440,"")'
  Set-MasterFormulaByHeader $masterSheet "cooldown_bucket" $lastColumn $lastRow '=IF(NOT(ISNUMBER(BT2)),"",IF(BT2<5,"0"&UNICHAR(8211)&"5 min",IF(BT2<10,"5"&UNICHAR(8211)&"10 min",IF(BT2<15,"10"&UNICHAR(8211)&"15 min",IF(BT2<30,"15"&UNICHAR(8211)&"30 min","30 min+")))))'
}

function Set-CategoryAxis($chart) {
  $xlCategory = 1
  $xlPrimary = 1
  $xlSecondary = 2
  $xlCategoryScale = 2
  try { $chart.Axes($xlCategory, $xlPrimary).CategoryType = $xlCategoryScale } catch {}
  try { $chart.Axes($xlCategory, $xlSecondary).CategoryType = $xlCategoryScale } catch {}
}

function Test-ChartCellHasData($sheet, [string]$address) {
  $cell = Invoke-ExcelRetry { $sheet.Range($address) }
  $value = Invoke-ExcelRetry { $cell.Value2 }
  $text = Invoke-ExcelRetry { [string]$cell.Text }
  if ($null -eq $value -or "$value" -eq "") { return $false }
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  if ($text.TrimStart().StartsWith("#")) { return $false }
  return $true
}

function Get-LastChartDataRow($sheet, [string]$xColumn, [string[]]$valueColumns, [int]$firstRow, [int]$lastRow) {
  if ($lastRow -lt $firstRow) { return $firstRow }
  for ($row = $lastRow; $row -ge $firstRow; $row--) {
    if (-not (Test-ChartCellHasData $sheet "${xColumn}${row}")) { continue }
    foreach ($valueColumn in $valueColumns) {
      if (Test-ChartCellHasData $sheet "${valueColumn}${row}") {
        return $row
      }
    }
  }
  return $firstRow
}

function Get-ChartLabelInterval([int]$dataPointCount) {
  if ($dataPointCount -le 20) { return 1 }
  if ($dataPointCount -le 60) { return 2 }
  if ($dataPointCount -le 150) { return 5 }
  return [Math]::Max(10, [int][Math]::Ceiling($dataPointCount / 30))
}

function Set-CategoryLabelInterval($chart, [int]$dataPointCount) {
  $xlCategory = 1
  $xlPrimary = 1
  $interval = Get-ChartLabelInterval $dataPointCount
  try {
    $axis = $chart.Axes($xlCategory, $xlPrimary)
    $axis.TickLabelSpacing = $interval
    $axis.TickMarkSpacing = $interval
  } catch {}
}

function Get-ValueColumnsFromMap([hashtable]$seriesMap) {
  $columns = New-Object 'System.Collections.Generic.List[string]'
  foreach ($valueColumn in $seriesMap.Values) {
    [void]$columns.Add([string]$valueColumn)
  }
  return $columns.ToArray()
}

function Set-SeriesRanges($chart, $analysisSheet, [string]$xColumn, [string[]]$valueColumns, [int]$firstRow, [int]$lastRow) {
  $lastRow = Get-LastChartDataRow $analysisSheet $xColumn $valueColumns $firstRow $lastRow
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
  $lastRow = Get-LastChartDataRow $analysisSheet $xColumn (Get-ValueColumnsFromMap $seriesMap) $firstRow $lastRow
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
  $lastRow = Get-LastChartDataRow $analysisSheet $xColumn @($valueColumn) $firstRow $lastRow
  $series = $chart.SeriesCollection()
  if ($series.Count -lt 1) { return }
  Invoke-ExcelRetry {
    $series.Item(1).XValues = $analysisSheet.Range("${xColumn}${firstRow}:${xColumn}${lastRow}")
    $series.Item(1).Values = $analysisSheet.Range("${valueColumn}${firstRow}:${valueColumn}${lastRow}")
  } | Out-Null
}

function Get-StaticChartDataRange($analysisSheet, [string]$xRange, [hashtable]$seriesMap) {
  $xCells = Invoke-ExcelRetry { $analysisSheet.Range($xRange) }
  $xFirstCell = Invoke-ExcelRetry { $xCells.Cells.Item(1) }
  $firstRow = [int](Invoke-ExcelRetry { $xFirstCell.Row })
  $lastRow = $firstRow + [int](Invoke-ExcelRetry { $xCells.Rows.Count }) - 1
  $xColumn = Get-ColumnLetter ([int](Invoke-ExcelRetry { $xFirstCell.Column }))
  $valueColumns = New-Object 'System.Collections.Generic.List[string]'
  foreach ($valueRange in $seriesMap.Values) {
    $cells = Invoke-ExcelRetry { $analysisSheet.Range([string]$valueRange) }
    $firstCell = Invoke-ExcelRetry { $cells.Cells.Item(1) }
    [void]$valueColumns.Add((Get-ColumnLetter ([int](Invoke-ExcelRetry { $firstCell.Column }))))
  }
  $actualLastRow = Get-LastChartDataRow $analysisSheet $xColumn $valueColumns.ToArray() $firstRow $lastRow
  return @{
    FirstRow = $firstRow
    LastRow = $actualLastRow
    XColumn = $xColumn
  }
}

function Set-StaticChartRanges($chart, $analysisSheet, [string]$xRange, [hashtable]$seriesMap) {
  $dataRange = Get-StaticChartDataRange $analysisSheet $xRange $seriesMap
  $firstRow = $dataRange.FirstRow
  $lastRow = $dataRange.LastRow
  $xColumn = $dataRange.XColumn
  $actualXRange = "${xColumn}${firstRow}:${xColumn}${lastRow}"
  $series = $chart.SeriesCollection()
  for ($i = 1; $i -le $series.Count; $i++) {
    $item = $series.Item($i)
    $name = ""
    try { $name = [string]$item.Name } catch {}
    if (-not $seriesMap.ContainsKey($name)) { continue }
    $valueRange = $seriesMap[$name]
    $valueCells = Invoke-ExcelRetry { $analysisSheet.Range($valueRange) }
    $valueFirstCell = Invoke-ExcelRetry { $valueCells.Cells.Item(1) }
    $valueColumn = Get-ColumnLetter ([int](Invoke-ExcelRetry { $valueFirstCell.Column }))
    $actualValueRange = "${valueColumn}${firstRow}:${valueColumn}${lastRow}"
    Invoke-ExcelRetry {
      $item.XValues = $analysisSheet.Range($actualXRange)
      $item.Values = $analysisSheet.Range($actualValueRange)
    } | Out-Null
  }
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
      $chartLastRow = Get-LastChartDataRow $analysisSheet "A" @("O") 2 $lastMasterRow
      Set-CategoryAxis $chart
      Set-FirstSeriesRange $chart $analysisSheet "A" "O" 2 $chartLastRow
      Set-CategoryLabelInterval $chart ([Math]::Max(1, $chartLastRow - 1))
    } elseif ($title -like "P&L % per Trade*") {
      Set-CategoryAxis $chart
      $pnlSeriesMap = @{
        "P&L % (Win)" = "BL"
        "P&L % (Loss)" = "BM"
      }
      if ($chart.SeriesCollection().Count -eq 1) {
        $chartLastRow = Get-LastChartDataRow $analysisSheet "AK" @("AQ") 2 $lastMasterRow
        Set-FirstSeriesRange $chart $analysisSheet "AK" "AQ" 2 $chartLastRow
      } else {
        $chartLastRow = Get-LastChartDataRow $analysisSheet "A" (Get-ValueColumnsFromMap $pnlSeriesMap) 2 $lastMasterRow
        Set-SeriesRangesByName $chart $analysisSheet "A" $pnlSeriesMap 2 $chartLastRow
      }
      Set-CategoryLabelInterval $chart ([Math]::Max(1, $chartLastRow - 1))
    } elseif ($title -eq "Entry Market Cap vs P&L %") {
      Set-FirstSeriesRange $chart $analysisSheet "AP" "AQ" 2 $lastMasterRow
    } elseif ($title -eq "Hold Time vs P&L %") {
      Set-FirstSeriesRange $chart $analysisSheet "AR" "AQ" 2 $lastMasterRow
    } elseif ($title -like "Win Rate *(bars)*Hold Time*") {
      Set-StaticChartRanges $chart $analysisSheet "AW12:AW16" @{
        "Win Rate" = "AY12:AY16"
        "# Trades" = "AX12:AX16"
        "Wtd Avg P&L %" = "BB12:BB16"
      }
    } elseif ($title -like "Win Rate *(bars)*Entry Market Cap*") {
      Set-StaticChartRanges $chart $analysisSheet "AW3:AW7" @{
        "# Trades" = "AX3:AX7"
        "Win Rate" = "AY3:AY7"
        "Wtd Avg P&L %" = "BB3:BB7"
      }
    } elseif ($title -like "Win Rate * Time-of-Day Bucket*") {
      Set-StaticChartRanges $chart $analysisSheet "AW37:AW43" @{
        "# Trades" = "AX37:AX43"
        "Win Rate" = "AY37:AY43"
        "Total SOL" = "BA37:BA43"
        "Wtd Avg P&L %" = "BB37:BB43"
      }
    } elseif ($title -like "Trade Distribution by P&L %*") {
      Set-StaticChartRanges $chart $analysisSheet "BN2:BN11" @{
        "# Trades" = "BO2:BO11"
      }
    } elseif ($title -like "Performance by Trade Type*") {
      Set-StaticChartRanges $chart $analysisSheet "BP2:BP4" @{
        "# Trades" = "BQ2:BQ4"
        "Win Rate" = "BR2:BR4"
        "Avg P&L %" = "BS2:BS4"
      }
    } elseif ($title -like "Performance by Accountability Bucket*") {
      Set-StaticChartRanges $chart $analysisSheet "BW2:BW4" @{
        "# Trades" = "BX2:BX4"
        "Win Rate" = "BY2:BY4"
        "Avg P&L %" = "BZ2:BZ4"
        "Total SOL" = "CA2:CA4"
      }
    } elseif ($title -like "Cooldown Analysis Performance*") {
      Set-StaticChartRanges $chart $analysisSheet "CK3:CK7" @{
        "# Clusters" = "CL3:CL7"
        "Win Rate" = "CM3:CM7"
        "Avg P&L %" = "CN3:CN7"
      }
    } elseif ($title -like "Session Performance by Trade Number*") {
      Set-StaticChartRanges $chart $analysisSheet "CQ3:CQ8" @{
        "# Trades" = "CR3:CR8"
        "Win Rate" = "CS3:CS8"
        "Avg P&L %" = "CT3:CT8"
      }
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
  $excel = Invoke-ExcelRetry { New-Object -ComObject Excel.Application }
  if ($null -eq $excel) {
    throw "Excel COM automation did not return an application instance."
  }
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
  $currentTradeColumnCount = Invoke-ExcelRetry { $tblTrades.Range.Columns.Count }
  $headerLastColumn = Invoke-ExcelRetry { $master.Cells(1, $master.Columns.Count).End($xlToLeft).Column }
  $lastTradeColumn = [Math]::Max([int]$currentTradeColumnCount, [int]$headerLastColumn)
  Invoke-ExcelRetry { $tblTrades.Resize($master.Range($master.Cells(1, 1), $master.Cells($lastMasterRow, $lastTradeColumn))) } | Out-Null
  Fill-MasterCalculatedColumns $master 56 $lastTradeColumn $lastMasterRow
  Refresh-CooldownFormulas $master $lastTradeColumn $lastMasterRow

  $tblAnalysis = $analysis.ListObjects.Item("tblAnalysis")
  Invoke-ExcelRetry { $tblAnalysis.Resize($analysis.Range("A1:O$lastMasterRow")) } | Out-Null

  Invoke-ExcelRetry { $master.Range("G2:G$lastMasterRow").NumberFormat = "m/d/yy" } | Out-Null
  Invoke-ExcelRetry { $master.Range("AK2:AK$lastMasterRow").NumberFormat = "0" } | Out-Null
  Invoke-ExcelRetry { $master.Range("AM2:AM$lastMasterRow").NumberFormat = "0" } | Out-Null
  Invoke-ExcelRetry { $master.Range("AO2:AO$lastMasterRow").NumberFormat = "0" } | Out-Null
  Invoke-ExcelRetry { $master.Range("AQ2:AQ$lastMasterRow").NumberFormat = "0" } | Out-Null
  Invoke-ExcelRetry { $master.Range("AS2:AS$lastMasterRow").NumberFormat = "0" } | Out-Null
  Invoke-ExcelRetry { $master.Range("AZ2:AZ$lastMasterRow").NumberFormat = "0" } | Out-Null
  Invoke-ExcelRetry { $master.Range("T2:V$lastMasterRow").NumberFormat = "0.000" } | Out-Null
  Invoke-ExcelRetry { $master.Range("W2:W$lastMasterRow").NumberFormat = "0.0%" } | Out-Null
  Invoke-ExcelRetry { $master.Range("BA2:BB$lastMasterRow").NumberFormat = "0.0%" } | Out-Null
  Invoke-ExcelRetry { $master.Range("BH2:BK$lastMasterRow").NumberFormat = "0.000" } | Out-Null
  Invoke-ExcelRetry { $master.Range("BL2:BN$lastMasterRow").NumberFormat = "0.0%" } | Out-Null
  Invoke-ExcelRetry { $master.Range("BR2:BS$lastMasterRow").NumberFormat = "yymmdd.hhmm" } | Out-Null
  Invoke-ExcelRetry { $master.Range("BT2:BT$lastMasterRow").NumberFormat = "0.0" } | Out-Null

  Invoke-ExcelRetry { $analysis.Range("A2:O$lastMasterRow").ClearContents() } | Out-Null
  Set-FormulaDown $analysis "A" 2 $lastMasterRow '=ROW()-1'
  Set-FormulaDown $analysis "B" 2 $lastMasterRow '=INDEX(tblTrades[token_name],ROW()-1)'
  Set-FormulaDown $analysis "C" 2 $lastMasterRow '=INDEX(tblTrades[entry_date],ROW()-1)'
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

  $dailyLastRow = Get-DailyLastRowFromMasterDates $master $lastMasterRow $helperLastRow
  Refresh-TradeCharts $workbook $analysis $lastMasterRow
  Refresh-DailyCharts $workbook $analysis $dailyLastRow

  # Persist table, helper formulas, and chart range updates before optional
  # calculation. Excel COM calculation can disconnect on some machines; it
  # must not discard formula propagation.
  Invoke-ExcelRetry { $workbook.Save() } | Out-Null
  Invoke-ExcelOptional { $excel.Calculation = -4105 } "Setting Excel calculation to automatic" | Out-Null
  Invoke-ExcelOptional { $workbook.ForceFullCalculation = $true } "Enabling full workbook recalculation" | Out-Null
  if (Invoke-ExcelOptional { $excel.CalculateFullRebuild() } "Excel full calculation") {
    Start-Sleep -Milliseconds 500
    Invoke-ExcelOptional { $workbook.Save() } "Saving recalculated workbook" | Out-Null
  }

  Write-Host (@{
    master = $masterPath
    lastMasterRow = $lastMasterRow
    helperLastRow = $helperLastRow
    dailyLastRow = $dailyLastRow
    warnings = @($script:finalizerWarnings)
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
