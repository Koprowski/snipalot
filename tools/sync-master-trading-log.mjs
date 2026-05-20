import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = resolveCapturesRoot();
const ARCHIVE = path.join(ROOT, "Archive");
const MASTER = resolveMasterPath();
const MANIFEST = path.join(ARCHIVE, "master-trading-log-sync-manifest.json");
const ENABLE_ARCHIVE_BACKFILL = process.argv.includes("--backfill-archive");
const REPAIR_ONLY = process.argv.includes("--repair-only");
const ARCHIVE_ONLY = process.argv.includes("--archive-only");
const TEST_MODE = process.argv.includes("--test-mode");
const NO_ARCHIVE = TEST_MODE || process.argv.includes("--no-archive");
const REPLACE_SOURCE_ROWS = TEST_MODE || process.argv.includes("--replace-source-rows");
const SUPPLEMENTAL_IMPORTS = [
  {
    filePath: path.join(ROOT, "master_trade_tracking_log_20260504_trade_workflow_format.xlsx"),
    sourceSession: "20260504 reconstructed feedback trades",
    sourceType: "reconstructed-workflow-xlsx",
  },
];

const WORKFLOW_COLUMNS = [
  "trade_id",
  "token_name",
  "trade_date",
  "video_start_time",
  "entry_commentary_time",
  "entry_time_inferred",
  "exit_commentary_time",
  "exit_time_actual",
  "time_in_trade_seconds",
  "video_end_time",
  "entry_mc_actual",
  "target_exit_low_mc",
  "target_exit_high_mc",
  "stop_loss_mc",
  "exit_mc_actual",
  "sol_invested",
  "sol_received",
  "pnl_sol",
  "pnl_percentage",
  "rationale",
  "pre_transcript_excerpt",
  "post_transcript_excerpt",
  "adherence_self_assessment",
  "notes",
  "needs_review",
  "mockape_trade_id",
];

const NICS_COLUMNS = [
  "meta_cluster_id",
  "meta_name",
  "N_score",
  "N_why",
  "I_score",
  "I_why",
  "C_score",
  "C_why",
  "S_score",
  "S_why",
  "NICS_score",
  "size_ok",
  "zone_ok",
  "cooldown_ok",
  "trade_type",
  "counts_toward_50",
  "hard_reset",
  "running_count",
  "non_nics_pnl_pct",
  "cluster_pnl_pct",
  "llm_grade_notes",
];

const LLM_NICS_COLUMNS = [
  "meta_name",
  "N_score",
  "N_why",
  "I_score",
  "I_why",
  "C_score",
  "C_why",
  "S_score",
  "S_why",
  "NICS_score",
  "trade_type",
  "llm_grade_notes",
];

const MASTER_COLUMNS = [
  "source_session",
  "source_log_type",
  "source_folder_archived_path",
  "processed_at",
  ...WORKFLOW_COLUMNS,
  "Hour",
  "Weekday",
  "WeekdayNum",
  "TimeBucket",
  ...NICS_COLUMNS,
];

const TRADE_LOG_COLUMNS = MASTER_COLUMNS;

function resolveCapturesRoot() {
  const rootArgIndex = process.argv.indexOf("--root");
  if (rootArgIndex >= 0 && process.argv[rootArgIndex + 1]) {
    return path.resolve(process.argv[rootArgIndex + 1]);
  }
  if (process.env.SNIPALOT_CAPTURES_ROOT) {
    return path.resolve(process.env.SNIPALOT_CAPTURES_ROOT);
  }
  if (fss.existsSync(path.join(SCRIPT_DIR, "master trading log.xlsx"))) {
    return SCRIPT_DIR;
  }
  const parent = path.dirname(SCRIPT_DIR);
  if (fss.existsSync(path.join(parent, "master trading log.xlsx"))) {
    return parent;
  }
  return "E:/OneDrive/Snipalot Captures";
}

function resolveMasterPath() {
  const masterArgIndex = process.argv.indexOf("--master");
  if (masterArgIndex >= 0 && process.argv[masterArgIndex + 1]) {
    return path.resolve(process.argv[masterArgIndex + 1]);
  }
  if (process.env.SNIPALOT_MASTER_TRADING_LOG) {
    return path.resolve(process.env.SNIPALOT_MASTER_TRADING_LOG);
  }

  const statementsMaster = path.join(ROOT, "Statements", "master trading log.xlsx");
  if (fss.existsSync(statementsMaster)) return statementsMaster;
  return path.join(ROOT, "master trading log.xlsx");
}

const INTEGER_COLUMNS = new Set([
  "trade_id",
  "time_in_trade_seconds",
  "N_score",
  "I_score",
  "C_score",
  "S_score",
  "NICS_score",
  "running_count",
]);

const WHOLE_NUMBER_COLUMNS = new Set([
  "entry_mc_actual",
  "target_exit_low_mc",
  "target_exit_high_mc",
  "stop_loss_mc",
  "exit_mc_actual",
]);

const DECIMAL_COLUMNS = new Set([
  "sol_invested",
  "sol_received",
  "pnl_sol",
  "non_nics_pnl_pct",
  "cluster_pnl_pct",
]);

const PERCENT_COLUMNS = new Set([
  "pnl_percentage",
]);

const BOOLEAN_COLUMNS = new Set([
  "size_ok",
  "zone_ok",
  "cooldown_ok",
  "counts_toward_50",
  "hard_reset",
]);

const DATE_COLUMNS = new Set([
  "trade_date",
]);

function folderDate(name) {
  const match = name.match(/^(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})/);
  if (!match) return "";
  return `${match[2]}/${match[3]}/${match[1].slice(2)}`;
}

function nowText() {
  return new Date().toLocaleString("en-US");
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (ch !== "\r") {
      value += ch;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

function rowsFromMatrix(matrix) {
  if (matrix.length === 0) return [];
  const headers = matrix[0].map((h) => String(h ?? "").trim());
  return matrix.slice(1).map((line) => {
    const row = {};
    headers.forEach((h, i) => {
      row[h] = String(line[i] ?? "");
    });
    return row;
  }).filter((row) => Object.values(row).some((value) => String(value).trim() !== ""));
}

function xmlDecode(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function columnIndex(cellRef) {
  const letters = cellRef.match(/[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n - 1;
}

async function readXlsxRows(filePath, sheetName = null) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const sharedStrings = await readSharedStrings(zip);
  const sheetPath = sheetName ? ((await worksheetPathForName(zip, sheetName)) ?? "xl/worksheets/sheet1.xml") : "xl/worksheets/sheet1.xml";
  const sheet = await zip.file(sheetPath)?.async("string");
  if (!sheet) return [];
  const matrix = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = cellMatch[1].match(/\br="([^"]+)"/)?.[1] ?? `A${matrix.length + 1}`;
      const type = cellMatch[1].match(/\bt="([^"]+)"/)?.[1] ?? "";
      const textPieces = [...cellMatch[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((m) => xmlDecode(m[1]));
      const numericValue = cellMatch[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
      if (type === "s" && numericValue !== "") {
        cells[columnIndex(ref)] = sharedStrings[Number(numericValue)] ?? "";
      } else if (type === "b" && numericValue !== "") {
        cells[columnIndex(ref)] = numericValue === "1" ? "TRUE" : "FALSE";
      } else {
        cells[columnIndex(ref)] = textPieces.length > 0 ? textPieces.join("") : xmlDecode(numericValue);
      }
    }
    matrix.push(cells.map((cell) => cell ?? ""));
  }
  return rowsFromMatrix(matrix);
}

async function readSharedStrings(zip) {
  const shared = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (!shared) return [];
  return [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((part) => xmlDecode(part[1]))
      .join("")
  );
}

async function worksheetPathForName(zip, sheetName) {
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbook || !rels) return null;
  const sheetMatch = [...workbook.matchAll(/<sheet\b([^>]*)\/>/g)]
    .find((match) => xmlDecode(match[1].match(/\bname="([^"]+)"/)?.[1] ?? "") === sheetName);
  const rid = sheetMatch?.[1].match(/\br:id="([^"]+)"/)?.[1];
  if (!rid) return null;
  const relMatch = [...rels.matchAll(/<Relationship\b([^>]*)\/>/g)]
    .find((match) => match[1].includes(`Id="${rid}"`));
  const target = relMatch?.[1].match(/\bTarget="([^"]+)"/)?.[1];
  if (!target) return null;
  return target.startsWith("xl/") ? target : `xl/${target.replace(/^\/?xl\//, "")}`;
}

async function readCsvRows(filePath) {
  return rowsFromMatrix(csvParse(await fs.readFile(filePath, "utf8")));
}

function normalizeWorkflowRow(row, sessionName, sourceType, archivePath) {
  const out = {
    source_session: sessionName,
    source_log_type: sourceType,
    source_folder_archived_path: archivePath,
    processed_at: nowText(),
  };
  for (const column of WORKFLOW_COLUMNS) out[column] = row[column] ?? "";
  for (const column of NICS_COLUMNS) out[column] = row[column] ?? "";
  if (!out.trade_date) out.trade_date = folderDate(sessionName);
  if (!out.entry_mc_actual && row.entry_mc_actual) out.entry_mc_actual = row.entry_mc_actual;
  if (!out.target_exit_low_mc && row.target_low_mc) out.target_exit_low_mc = row.target_low_mc;
  if (!out.target_exit_high_mc && row.target_high_mc) out.target_exit_high_mc = row.target_high_mc;
  if (!out.exit_mc_actual && row.exit_mc_actual) out.exit_mc_actual = row.exit_mc_actual;
  if (!out.needs_review && row.needs_review) out.needs_review = row.needs_review;
  if (!out.notes && sourceType === "legacy-csv") out.notes = row.notes || "Imported from legacy trade_log.csv.";
  fillTimeBucketFields(out);
  return out;
}

function fillTimeBucketFields(row) {
  if (!isBlank(row.Hour) && !isBlank(row.Weekday) && !isBlank(row.WeekdayNum) && !isBlank(row.TimeBucket)) return;
  const serial = parseDateSerial(row.trade_date);
  const time = parseTimeParts(firstNonBlank(row.entry_time_inferred, row.entry_commentary_time, row.exit_time_actual, row.video_start_time));
  if (serial === null || !time) return;
  const date = dateFromExcelSerial(serial);
  const jsDay = date.getUTCDay();
  const weekdayNum = jsDay === 0 ? 7 : jsDay;
  const hour = time.hour;
  if (isBlank(row.Hour)) row.Hour = String(hour);
  if (isBlank(row.Weekday)) row.Weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][jsDay];
  if (isBlank(row.WeekdayNum)) row.WeekdayNum = String(weekdayNum);
  if (isBlank(row.TimeBucket)) row.TimeBucket = timeBucketLabel(weekdayNum, hour);
}

function timeBucketLabel(weekdayNum, hour) {
  if (weekdayNum <= 4 && hour < 18) return "WD 6am-6pm";
  if (weekdayNum === 5 && hour < 18) return "WD 6am-6pm";
  if (weekdayNum <= 4 && (hour === 18 || hour === 19)) return "WD 6pm-8pm";
  if (weekdayNum <= 4 && hour >= 20 && hour <= 23) return "WD 8pm-12am";
  if (weekdayNum <= 4 && (hour === 0 || hour === 1)) return "WD 6am-6pm";
  if ((weekdayNum === 6 || weekdayNum === 7) && hour >= 2 && hour <= 11) return "WE 6am-12pm";
  if ((weekdayNum === 6 || weekdayNum === 7) && hour >= 12 && hour <= 17) return "WE 12pm-6pm";
  if ((weekdayNum === 5 || weekdayNum === 6 || weekdayNum === 7) && (hour === 18 || hour === 19)) return "WE 6pm-8pm";
  if (weekdayNum === 5 && hour >= 20 && hour <= 23) return "WE 8pm-2am";
  if (weekdayNum === 6 && (hour >= 20 || hour <= 1)) return "WE 8pm-2am";
  if (weekdayNum === 7 && hour >= 20 && hour <= 23) return "WE 8pm-2am";
  if (weekdayNum === 7 && (hour === 0 || hour === 1)) return "WE 8pm-2am";
  return "";
}

function rowKey(row) {
  return [
    row.mockape_trade_id || "",
    row.source_session || "",
    row.trade_id || "",
    row.token_name || "",
    row.exit_time_actual || "",
  ].join("::");
}

function sortRowsForAppend(rows) {
  return [...rows].sort((a, b) => {
    const aKey = sortableDateTimeKey(a.trade_date, a.video_start_time || a.entry_time_inferred || a.exit_time_actual);
    const bKey = sortableDateTimeKey(b.trade_date, b.video_start_time || b.entry_time_inferred || b.exit_time_actual);
    return aKey.localeCompare(bKey) ||
      String(a.source_session ?? "").localeCompare(String(b.source_session ?? "")) ||
      String(a.trade_id ?? "").localeCompare(String(b.trade_id ?? ""), undefined, { numeric: true });
  });
}

function sortableDateTimeKey(dateValue, timeValue) {
  return `${sortableDateKey(dateValue)} ${sortableTimeKey(timeValue)}`;
}

function sortableDateKey(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return "9999-99-99";
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year.padStart(4, "0")}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function sortableTimeKey(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return "99:99:99";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  const ampm = match[4]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

async function loadExistingMaster() {
  if (!fss.existsSync(MASTER)) return [];
  return readXlsxRows(MASTER, "Master Trading Log");
}

async function saveMaster(allRows, rowsToAppend, forceRewrite = false) {
  if (forceRewrite && fss.existsSync(MASTER) && await canUpdateExistingWorkbook(MASTER)) {
    await rewriteExistingMasterWorkbook(MASTER, allRows);
    return true;
  }
  if (rowsToAppend.length === 0) {
    if (fss.existsSync(MASTER) && await canUpdateExistingWorkbook(MASTER)) {
      return repairExistingWorkbook(MASTER);
    }
    return false;
  }
  if (!fss.existsSync(MASTER)) {
    await writeXlsx(MASTER, allRows);
    return true;
  }
  if (!await canUpdateExistingWorkbook(MASTER)) {
    throw new Error(`Cannot find "Master Trading Log" in ${MASTER}; refusing to rewrite workbook destructively.`);
  }
  await appendRowsToExistingWorkbook(MASTER, rowsToAppend);
  return true;
}

async function archiveFolder(folderPath) {
  await fs.mkdir(ARCHIVE, { recursive: true });
  const name = path.basename(folderPath);
  let target = path.join(ARCHIVE, name);
  if (fss.existsSync(target)) {
    target = path.join(ARCHIVE, `${name} archived ${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
  await fs.rename(folderPath, target);
  return target;
}

async function loadManifest() {
  if (!fss.existsSync(MANIFEST)) return [];
  try {
    return JSON.parse(await fs.readFile(MANIFEST, "utf8"));
  } catch {
    return [];
  }
}

async function saveManifest(entries) {
  await fs.mkdir(ARCHIVE, { recursive: true });
  await fs.writeFile(MANIFEST, JSON.stringify(entries, null, 2), "utf8");
}

async function main() {
  await fs.mkdir(ARCHIVE, { recursive: true });
  const manifest = await loadManifest();

  if (ARCHIVE_ONLY) {
    const dirs = await listCurrentTradeDirs();
    const results = [];
    const skippedFolders = [];
    for (const dir of dirs) {
      if (!hasImportableTradeLog(dir)) {
        skippedFolders.push(path.basename(dir));
        continue;
      }
      const archiveTarget = await archiveFolder(dir);
      const result = {
        sessionName: path.basename(dir),
        sourceType: "archive-only",
        rowsFound: null,
        rowsAdded: 0,
        rowsBackfilled: 0,
        archivedTo: archiveTarget,
        processedAt: new Date().toISOString(),
      };
      manifest.push(result);
      results.push(result);
    }
    await saveManifest(manifest);
    console.log(JSON.stringify({
      root: ROOT,
      archive: ARCHIVE,
      archiveOnly: true,
      processedFolders: results.length,
      skippedFolders,
      results,
    }, null, 2));
    return;
  }

  const existing = await loadExistingMaster();

  if (REPAIR_ONLY) {
    const workbookUpdated = fss.existsSync(MASTER) && await canUpdateExistingWorkbook(MASTER)
      ? await repairExistingWorkbook(MASTER)
      : false;
    console.log(JSON.stringify({
      master: MASTER,
      archive: ARCHIVE,
      repairOnly: true,
      processedFolders: 0,
      backfilledArchivedFolders: 0,
      rowsInMaster: existing.length,
      rowsAppended: 0,
      workbookUpdated,
      results: [],
      backfillResults: [],
      supplementalResults: [],
    }, null, 2));
    return;
  }

  const dirs = await listCurrentTradeDirs();

  const archivedDirs = ENABLE_ARCHIVE_BACKFILL && fss.existsSync(ARCHIVE)
    ? (await fs.readdir(ARCHIVE, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(" trade"))
      .map((entry) => path.join(ARCHIVE, entry.name))
      .sort()
    : [];

  let allRows = [...existing];
  let rowsRemovedBeforeImport = 0;
  if (REPLACE_SOURCE_ROWS) {
    const sessionsToReplace = new Set(
      [...dirs, ...archivedDirs]
        .filter(hasImportableTradeLog)
        .map((dir) => path.basename(dir))
    );
    if (sessionsToReplace.size > 0) {
      const before = allRows.length;
      allRows = allRows.filter((row) => !sessionsToReplace.has(String(row.source_session ?? "")));
      rowsRemovedBeforeImport = before - allRows.length;
    }
  }

  const existingRowCount = allRows.length;
  const seen = new Set(allRows.map(rowKey));

  const results = [];
  for (const dir of dirs) {
    const result = await importTradeFolder(dir, {
      allRows,
      seen,
      archiveAfterImport: !NO_ARCHIVE,
    });
    manifest.push(result);
    results.push(result);
  }

  const backfillResults = [];
  for (const dir of archivedDirs) {
    const result = await importTradeFolder(dir, {
      allRows,
      seen,
      archiveAfterImport: false,
    });
    if (result.rowsAdded > 0) backfillResults.push(result);
  }

  const supplementalResults = [];
  for (const source of SUPPLEMENTAL_IMPORTS) {
    if (!fss.existsSync(source.filePath)) continue;
    supplementalResults.push(await importWorkbookRows(source, { allRows, seen }));
  }

  const rowsToAppend = sortRowsForAppend(allRows.slice(existingRowCount));
  const rowsBackfilled = [...results, ...backfillResults, ...supplementalResults]
    .reduce((sum, result) => sum + (result.rowsBackfilled ?? 0), 0);
  const forceRewrite = rowsBackfilled > 0 || rowsRemovedBeforeImport > 0;
  const rowsForSave = forceRewrite
    ? [...allRows.slice(0, existingRowCount), ...rowsToAppend]
    : allRows;
  const workbookUpdated = await saveMaster(rowsForSave, rowsToAppend, forceRewrite);
  await saveManifest(manifest);

  console.log(JSON.stringify({
    master: MASTER,
    archive: ARCHIVE,
    testMode: TEST_MODE,
    archiveAfterImport: !NO_ARCHIVE,
    replaceSourceRows: REPLACE_SOURCE_ROWS,
    processedFolders: results.length,
    backfilledArchivedFolders: backfillResults.length,
    rowsRemovedBeforeImport,
    rowsInMaster: allRows.length,
    rowsAppended: rowsToAppend.length,
    rowsBackfilled,
    workbookUpdated,
    results,
    backfillResults,
    supplementalResults,
  }, null, 2));
}

await main();

async function listCurrentTradeDirs() {
  return (await fs.readdir(ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(" trade"))
    .map((entry) => path.join(ROOT, entry.name))
    .sort();
}

function hasImportableTradeLog(dir) {
  return fss.existsSync(path.join(dir, "trade_log.xlsx")) || fss.existsSync(path.join(dir, "trade_log.csv"));
}

async function importTradeFolder(dir, { allRows, seen, archiveAfterImport }) {
  const sessionName = path.basename(dir);
  const xlsx = path.join(dir, "trade_log.xlsx");
  const csv = path.join(dir, "trade_log.csv");
  let rawRows = [];
  let sourceType = "missing-log";
  if (fss.existsSync(xlsx)) {
    rawRows = await readXlsxRows(xlsx);
    sourceType = "workflow-xlsx";
  } else if (fss.existsSync(csv)) {
    rawRows = await readCsvRows(csv);
    sourceType = "legacy-csv";
  }
  rawRows = await ensureNicsResponseRows(dir, rawRows);

  let added = 0;
  let backfilled = 0;
  let archiveTarget = archiveAfterImport ? path.join(ARCHIVE, sessionName) : dir;
  if (rawRows.length > 0) {
    rawRows = reconcileNicsFields(rawRows, allRows, sessionName);
    if (fss.existsSync(xlsx)) {
      const sessionRows = rawRows.map((row) => normalizeWorkflowRow(row, sessionName, sourceType, archiveTarget));
      await writeTradeLogRowsXlsx(xlsx, sessionRows);
    }
    for (const raw of rawRows) {
      const row = normalizeWorkflowRow(raw, sessionName, sourceType, archiveTarget);
      const key = rowKey(row);
      if (!seen.has(key)) {
        seen.add(key);
        allRows.push(row);
        added++;
      } else if (backfillMissingNicsFields(allRows, key, row)) {
        backfilled++;
      }
    }
  }

  if (archiveAfterImport) {
    archiveTarget = await archiveFolder(dir);
    for (const row of allRows) {
      if (row.source_session === sessionName) row.source_folder_archived_path = archiveTarget;
    }
  }

  return {
    sessionName,
    sourceType,
    rowsFound: rawRows.length,
    rowsAdded: added,
    rowsBackfilled: backfilled,
    archivedTo: archiveTarget,
    processedAt: new Date().toISOString(),
  };
}

async function mergeNicsResponseRows(sessionDir, rawRows) {
  const responsePath = path.join(sessionDir, "Inputs", "nics_response.json");
  if (!fss.existsSync(responsePath) || rawRows.length === 0) return rawRows;
  let gradedRows = [];
  try {
    gradedRows = parseNicsResponseJson(await fs.readFile(responsePath, "utf8"));
  } catch (err) {
    console.warn(`[sync] Ignoring invalid NICS response ${responsePath}: ${err.message}`);
    return rawRows;
  }
  const byKey = new Map(rawRows.map((row) => [nicsMergeKey(row), row]));
  let merged = 0;
  for (const graded of gradedRows) {
    const target = byKey.get(nicsMergeKey(graded));
    if (!target) continue;
    for (const column of LLM_NICS_COLUMNS) {
      if (!isBlank(graded[column])) target[column] = String(graded[column]);
    }
    merged++;
  }
  if (merged > 0) console.log(`[sync] merged ${merged} NICS response row(s) from ${responsePath}`);
  return rawRows;
}

async function ensureNicsResponseRows(sessionDir, rawRows) {
  let rows = await mergeNicsResponseRows(sessionDir, rawRows);
  if (!hasMissingNicsJudgments(rows)) return rows;

  const generated = await generateNicsResponseFromSessionEvidence(sessionDir, rows);
  if (!generated) return rows;
  rows = await mergeNicsResponseRows(sessionDir, rows);
  return rows;
}

function hasMissingNicsJudgments(rows) {
  return rows.some((row) => !hasCompleteNicsJudgment(row));
}

function hasCompleteNicsJudgment(row) {
  return !isBlank(row.meta_name)
    && !isBlank(row.N_score)
    && !isBlank(row.N_why)
    && !isBlank(row.I_score)
    && !isBlank(row.I_why)
    && !isBlank(row.C_score)
    && !isBlank(row.C_why)
    && !isBlank(row.S_score)
    && !isBlank(row.S_why);
}

async function generateNicsResponseFromSessionEvidence(sessionDir, rawRows) {
  const evidence = await readSessionEvidence(sessionDir);
  if (!evidence.hasUsefulEvidence && !rawRows.some(rowHasNicsEvidenceText)) {
    console.warn(`[sync] NICS missing for ${path.basename(sessionDir)}, but no transcript/prompt/extraction evidence was found.`);
    return false;
  }

  const inputsDir = path.join(sessionDir, "Inputs");
  const responsePath = path.join(inputsDir, "nics_response.json");
  const promptText = renderSyncNicsPrompt(sessionDir, rawRows, evidence);
  console.log(`[sync] generating missing NICS classifications for ${path.basename(sessionDir)} from saved session evidence`);

  let gradedRows = [];
  try {
    gradedRows = await runGeminiCliForNics(promptText);
  } catch (err) {
    console.warn(`[sync] NICS generation failed for ${path.basename(sessionDir)}: ${err.message}`);
    return false;
  }
  if (!Array.isArray(gradedRows) || gradedRows.length === 0) {
    console.warn(`[sync] NICS generation returned no rows for ${path.basename(sessionDir)}.`);
    return false;
  }

  await fs.mkdir(inputsDir, { recursive: true });
  await fs.writeFile(responsePath, `${JSON.stringify(gradedRows, null, 2)}\n`, "utf8");
  console.log(`[sync] wrote generated NICS response to ${responsePath}`);
  return true;
}

function rowHasNicsEvidenceText(row) {
  return !isBlank(row.rationale)
    || !isBlank(row.pre_transcript_excerpt)
    || !isBlank(row.post_transcript_excerpt)
    || !isBlank(row.adherence_self_assessment)
    || !isBlank(row.notes);
}

async function readSessionEvidence(sessionDir) {
  const transcript = await readTextIfExists(path.join(sessionDir, "transcript.txt"), 90000);
  const prompt = await readTextIfExists(path.join(sessionDir, "prompt.txt"), 50000);
  const extractionResponse = await readTextIfExists(path.join(sessionDir, "Inputs", "extraction_response.json"), 50000);
  const mockape = await readTextIfExists(path.join(sessionDir, "Inputs", "mockape.json"), 40000);
  const markers = await readTextIfExists(path.join(sessionDir, "Inputs", "markers.json"), 20000);
  return {
    transcript,
    prompt,
    extractionResponse,
    mockape,
    markers,
    hasUsefulEvidence: Boolean(transcript || prompt || extractionResponse || mockape || markers),
  };
}

async function readTextIfExists(filePath, maxChars) {
  if (!fss.existsSync(filePath)) return "";
  try {
    const text = await fs.readFile(filePath, "utf8");
    return truncateForPrompt(text.replace(/^\uFEFF/, ""), maxChars, filePath);
  } catch (err) {
    console.warn(`[sync] Could not read ${filePath}: ${err.message}`);
    return "";
  }
}

function truncateForPrompt(text, maxChars, label) {
  if (!text || text.length <= maxChars) return text;
  const keepHead = Math.floor(maxChars * 0.65);
  const keepTail = maxChars - keepHead;
  return `${text.slice(0, keepHead)}\n\n[${label} truncated for sync-time NICS grading]\n\n${text.slice(-keepTail)}`;
}

function renderSyncNicsPrompt(sessionDir, rawRows, evidence) {
  const rowsForGrading = rawRows.map((row) => {
    const out = {};
    for (const column of [
      "trade_id",
      "token_name",
      "mockape_trade_id",
      "trade_date",
      "entry_time_inferred",
      "exit_time_actual",
      "entry_mc_actual",
      "target_exit_low_mc",
      "target_exit_high_mc",
      "stop_loss_mc",
      "exit_mc_actual",
      "sol_invested",
      "pnl_percentage",
      "rationale",
      "pre_transcript_excerpt",
      "post_transcript_excerpt",
      "adherence_self_assessment",
      "notes",
      ...LLM_NICS_COLUMNS,
    ]) {
      out[column] = row[column] ?? "";
    }
    return out;
  });

  return `You are reconciling Snipalot trade rows during master-log sync.

Return ONLY a JSON array. Return one object per input trade row. Each object MUST include:
trade_id, token_name, mockape_trade_id, meta_name, N_score, N_why, I_score, I_why, C_score, C_why, S_score, S_why, NICS_score, trade_type, llm_grade_notes.

Use the saved evidence from the session folder to fill only missing NICS/meta classification fields.

Scoring rules:
- N_score, I_score, C_score, and S_score are binary 0 or 1.
- NICS_score = N_score + I_score + C_score + S_score. It ranges from 0 to 4.
- A trade counts as Core NICS++ only when NICS_score = 4, subject to the separate size/zone/cooldown checks handled by the sync script.
- N = the trader clearly names the narrative/meta/setup being traded, not just the ticker.
- I = the trader states why this specific token is the selected ticket for that meta or what immediate evidence supports entry.
- C = the trader gives the actual cut/close reason: why they got out, what failed, what changed, or what stopped working.
- S = the trader states the sell/stay plan for a working trade: profit target, scale-out, cost recovery, trailing logic, or upside management.
- meta_name should identify the repeatable meta cluster, not necessarily the ticker. If multiple tickers are lottery tickets for the same idea, use the same meta_name.
- Use 0 and explain the missing evidence when a component is absent. Do not leave any N/I/C/S fields blank.
- Use Core NICS++ only for NICS_score = 4. Use Scout when the row has partial NICS evidence worth reviewing. Use Non-NICS when it lacks a named/intentional setup.
- Do not populate meta_cluster_id, size_ok, zone_ok, cooldown_ok, counts_toward_50, hard_reset, running_count, non_nics_pnl_pct, or cluster_pnl_pct. The sync script owns those fields.
- Existing prompt text is context only; the scoring rules above override older prompt instructions if they conflict.

Session folder:
${path.basename(sessionDir)}

Trade rows to grade:
${JSON.stringify(rowsForGrading, null, 2)}

Transcript evidence:
${evidence.transcript || "(missing)"}

Original prompt evidence:
${evidence.prompt || "(missing)"}

Original extraction response evidence:
${evidence.extractionResponse || "(missing)"}

MockApe evidence:
${evidence.mockape || "(missing)"}

Marker evidence:
${evidence.markers || "(missing)"}
`;
}

async function runGeminiCliForNics(promptText) {
  const { command, model } = readGeminiCliSyncConfig();
  const resolvedCli = resolveGeminiCliExecutable(command);
  const timeoutMs = Number(process.env.SNIPALOT_NICS_SYNC_TIMEOUT_MS ?? 8 * 60 * 1000);
  const instruction = "Grade the Snipalot trade rows from stdin. Return only the requested JSON array.";

  let result = await runProcess(
    resolvedCli,
    ["--model", model, "--output-format", "json", "--prompt", instruction],
    promptText,
    timeoutMs
  );
  let fallback = "none";
  if (result.code !== 0 && /Cannot use both a positional prompt and the --prompt flag together/i.test(result.stderr)) {
    result = await runProcess(
      resolvedCli,
      ["--model", model, "--output-format", "json", instruction],
      promptText,
      timeoutMs
    );
    fallback = "positional-prompt";
  }

  if (result.timedOut) {
    throw new Error(`Gemini CLI timed out after ${timeoutMs} ms`);
  }
  if (result.code !== 0) {
    throw new Error(`Gemini CLI exited ${result.code} (${fallback}): ${result.stderr.slice(0, 700)}`);
  }

  const rawText = extractGeminiCliResponseText(result.stdout);
  if (!rawText) throw new Error("Gemini CLI returned an empty response.");
  const parsed = parseNicsResponseJson(rawText);
  if (!Array.isArray(parsed)) throw new Error("Gemini CLI response did not parse to a JSON array.");
  return parsed;
}

function readGeminiCliSyncConfig() {
  let command = process.env.SNIPALOT_GEMINI_CLI_COMMAND || "";
  let model = process.env.SNIPALOT_GEMINI_CLI_MODEL || "";
  if (!command || !model) {
    const configPath = path.join(os.homedir(), ".snipalot", "config.json");
    try {
      if (fss.existsSync(configPath)) {
        const config = JSON.parse(fss.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
        command ||= config?.trade?.geminiCliCommand ?? "";
        model ||= config?.trade?.geminiCliModel ?? "";
      }
    } catch (err) {
      console.warn(`[sync] Could not read Gemini CLI settings from ${configPath}: ${err.message}`);
    }
  }
  return {
    command: (command || "gemini").trim(),
    model: (model || "gemini-3.1-pro-preview").trim(),
  };
}

function resolveGeminiCliExecutable(cliCommand) {
  const raw = (cliCommand || "gemini").trim() || "gemini";
  const trimmed = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  const asTarget = (command, prefixArgs = [], shell = false) => ({ command, prefixArgs, shell });
  const ext = path.extname(trimmed).toLowerCase();
  const cmdLikeExt = ext === ".cmd" || ext === ".bat";

  const tryNodeEntryFromShim = (shimPath) => {
    const shimDir = path.dirname(shimPath);
    const pkgRoot = path.join(shimDir, "node_modules", "@google", "gemini-cli");
    try {
      const pkgJsonPath = path.join(pkgRoot, "package.json");
      if (fss.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fss.readFileSync(pkgJsonPath, "utf8"));
        const binEntry = typeof pkg.bin === "string"
          ? pkg.bin
          : (pkg.bin && (pkg.bin.gemini ?? Object.values(pkg.bin)[0])) ?? pkg.main;
        if (binEntry) {
          const resolved = path.join(pkgRoot, binEntry);
          if (fss.existsSync(resolved)) return asTarget(process.execPath, [resolved]);
        }
      }
    } catch {
      // fall through to static candidates
    }
    const candidates = [
      path.join(pkgRoot, "bundle", "gemini.js"),
      path.join(pkgRoot, "dist", "index.js"),
      path.join(pkgRoot, "bin", "gemini.js"),
      path.join(pkgRoot, "index.js"),
    ];
    const entry = candidates.find((candidate) => fss.existsSync(candidate));
    return entry ? asTarget(process.execPath, [entry]) : null;
  };

  if (path.isAbsolute(trimmed)) {
    if (fss.existsSync(trimmed)) {
      if (process.platform === "win32" && cmdLikeExt) return tryNodeEntryFromShim(trimmed) ?? asTarget(trimmed, [], true);
      return asTarget(trimmed);
    }
    const withCmd = `${trimmed}.cmd`;
    if (fss.existsSync(withCmd)) return tryNodeEntryFromShim(withCmd) ?? asTarget(withCmd, [], true);
    const withExe = `${trimmed}.exe`;
    if (fss.existsSync(withExe)) return asTarget(withExe);
    return process.platform === "win32" && !ext ? asTarget(withCmd, [], true) : asTarget(trimmed);
  }

  if (trimmed.includes(path.sep) || trimmed.includes("/")) {
    if (process.platform === "win32" && !ext) return asTarget(`${trimmed}.cmd`, [], true);
    if (process.platform === "win32" && cmdLikeExt) return asTarget(trimmed, [], true);
    return asTarget(trimmed);
  }

  if (process.platform !== "win32") return asTarget(trimmed);

  const tryWhere = (name) => {
    try {
      const stdout = execFileSync("where.exe", [name], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return lines.find((candidate) => /\.(cmd|exe|bat)$/i.test(candidate) && fss.existsSync(candidate))
        ?? lines.find((candidate) => fss.existsSync(candidate))
        ?? null;
    } catch {
      return null;
    }
  };

  const fromWhere = tryWhere(`${trimmed}.cmd`) ?? tryWhere(`${trimmed}.exe`) ?? tryWhere(trimmed);
  if (fromWhere) {
    if (/\.(cmd|bat)$/i.test(fromWhere)) return tryNodeEntryFromShim(fromWhere) ?? asTarget(fromWhere, [], true);
    return asTarget(fromWhere);
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const npmShim = path.join(appData, "npm", `${trimmed}.cmd`);
    if (fss.existsSync(npmShim)) return tryNodeEntryFromShim(npmShim) ?? asTarget(npmShim, [], true);
  }
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    const npmShim = path.join(userProfile, "AppData", "Roaming", "npm", `${trimmed}.cmd`);
    if (fss.existsSync(npmShim)) return tryNodeEntryFromShim(npmShim) ?? asTarget(npmShim, [], true);
  }

  return asTarget(trimmed);
}

function runProcess(resolvedCli, args, stdinText, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const env = {
      ...process.env,
      GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? "true",
      GEMINI_CLI_NO_RELAUNCH: "true",
    };
    delete env.GEMINI_API_KEY;

    let child;
    try {
      child = spawn(resolvedCli.command, [...resolvedCli.prefixArgs, ...args], {
        windowsHide: true,
        shell: resolvedCli.shell,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: err.message, timedOut });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin?.end(stdinText, "utf8");
  });
}

function extractGeminiCliResponseText(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.response === "string" && parsed.response.trim()) return parsed.response.trim();
    if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
    if (parsed.content && typeof parsed.content.text === "string" && parsed.content.text.trim()) {
      return parsed.content.text.trim();
    }
  } catch {
    // CLI can return plain JSON/text when output-format behavior changes.
  }
  return trimmed;
}

function parseNicsResponseJson(rawText) {
  let text = rawText.trim().replace(/^\uFEFF/, "");
  const directFence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (directFence) text = directFence[1].trim();
  const wrapper = JSON.parse(text);
  if (Array.isArray(wrapper)) return wrapper;
  if (wrapper && typeof wrapper.response === "string") {
    text = wrapper.response.trim();
    const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
    return JSON.parse(fence ? fence[1].trim() : text);
  }
  throw new Error("NICS response must be a JSON array or Gemini JSON wrapper with response.");
}

function nicsMergeKey(row) {
  return [
    row.mockape_trade_id ?? "",
    String(row.trade_id ?? ""),
    String(row.token_name ?? "").trim().toLowerCase(),
  ].join("::");
}

function reconcileNicsFields(rawRows, existingRows, sessionName) {
  const rows = rawRows.map((row) => ({ ...row }));
  const state = buildNicsReconciliationState(existingRows);
  const completed = [];

  for (const row of rows) {
    if (isBlank(row.meta_name)) row.meta_name = row.token_name ?? "";

    const metaKey = metaKeyFor(row);
    if (metaKey) {
      let clusterId = firstNonBlank(row.meta_cluster_id, state.clusterByMeta.get(metaKey));
      if (!clusterId) {
        const dateCode = clusterDateCode(row, sessionName);
        const next = (state.nextClusterByDate.get(dateCode) ?? 1);
        clusterId = `M.${dateCode}.${next}`;
        state.nextClusterByDate.set(dateCode, next + 1);
      }
      row.meta_cluster_id = clusterId;
      state.clusterByMeta.set(metaKey, clusterId);
    }

    fillNicsScore(row);
    fillSetupFlags(row);
    fillTradeType(row);
    fillCooldownFlag(row, state.history);
    fillCountFields(row, state.history);
    completed.push(row);
    state.history.push(row);
  }

  fillClusterPnl(rows, [...existingRows, ...completed]);
  return rows;
}

function backfillMissingNicsFields(allRows, key, sourceRow) {
  const target = allRows.find((row) => rowKey(row) === key);
  if (!target) return false;
  let changed = false;
  for (const column of NICS_COLUMNS) {
    if (isBlank(target[column]) && !isBlank(sourceRow[column])) {
      target[column] = sourceRow[column];
      changed = true;
    }
  }
  return changed;
}

function buildNicsReconciliationState(existingRows) {
  const clusterByMeta = new Map();
  const nextClusterByDate = new Map();
  const history = [];

  for (const row of existingRows) {
    const clusterId = String(row.meta_cluster_id ?? "").trim();
    const metaKey = metaKeyFor(row);
    if (clusterId && metaKey && !clusterByMeta.has(metaKey)) clusterByMeta.set(metaKey, clusterId);
    const parsed = parseClusterId(clusterId);
    if (parsed) {
      const next = Math.max(nextClusterByDate.get(parsed.dateCode) ?? 1, parsed.index + 1);
      nextClusterByDate.set(parsed.dateCode, next);
    }
    history.push(row);
  }

  return { clusterByMeta, nextClusterByDate, history };
}

function parseClusterId(value) {
  const match = String(value ?? "").trim().match(/^M\.(\d{6})\.(\d+)$/i);
  if (!match) return null;
  return { dateCode: match[1], index: Number(match[2]) };
}

function metaKeyFor(row) {
  const raw = firstNonBlank(row.meta_name, row.token_name);
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (!isBlank(value)) return value;
  }
  return "";
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function clusterDateCode(row, sessionName) {
  const serial = parseDateSerial(firstNonBlank(row.trade_date, folderDate(sessionName)));
  const date = serial === null ? dateFromSessionName(sessionName) : dateFromExcelSerial(serial);
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function dateFromSessionName(sessionName) {
  const match = String(sessionName ?? "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return new Date();
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function dateFromExcelSerial(serial) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
}

function fillNicsScore(row) {
  const score = nicsUnlockScore(row);
  if (score !== null) row.NICS_score = String(score);
}

function fillSetupFlags(row) {
  const sol = parseNumber(row.sol_invested);
  if (sol !== null) row.size_ok = Math.abs(sol - 0.5) < 0.0001 ? "true" : "false";
  const entryMc = parseNumber(row.entry_mc_actual);
  if (entryMc !== null) row.zone_ok = entryMc >= 2000 && entryMc <= 20000 ? "true" : "false";
}

function fillTradeType(row) {
  if (!isBlank(row.trade_type)) return;
  const evidenceOk = hasCountedNicsEvidence(row);
  if (evidenceOk === null) return;
  row.trade_type = evidenceOk ? "Core NICS++" : "Non-NICS";
}

function fillCooldownFlag(row, history) {
  const currentTime = rowDateTimeMs(row);
  if (currentTime === null) return;
  const previousLoss = [...history]
    .map((candidate) => ({ row: candidate, time: rowDateTimeMs(candidate) }))
    .filter((candidate) => candidate.time !== null && candidate.time < currentTime && parseNumber(candidate.row.pnl_percentage) !== null)
    .sort((a, b) => b.time - a.time)
    .find((candidate) => (parseNumber(candidate.row.pnl_percentage) ?? 0) < 0);
  if (!previousLoss) {
    row.cooldown_ok = "true";
    return;
  }
  const minutesSinceLoss = (currentTime - previousLoss.time) / 60000;
  row.cooldown_ok = minutesSinceLoss >= 5 ? "true" : "false";
}

function fillCountFields(row, history) {
  const evidenceOk = hasCountedNicsEvidence(row);
  const sizeOk = parseBoolean(row.size_ok);
  const zoneOk = parseBoolean(row.zone_ok);
  const cooldownOk = parseBoolean(row.cooldown_ok);
  const hardReset = isAboveHalfSol(row) === true || cooldownOk === false;
  const counts = evidenceOk === true && sizeOk === true && zoneOk === true && hardReset === false;
  row.counts_toward_50 = counts ? "true" : "false";
  row.hard_reset = hardReset ? "true" : "false";

  const previousCount = latestRunningCount(history);
  row.running_count = String(hardReset ? 0 : previousCount + (counts ? 1 : 0));
  const pnl = parseNumber(row.pnl_percentage);
  if (pnl !== null) row.non_nics_pnl_pct = counts ? "" : String(pnl);
}

function nicsUnlockScore(row) {
  const n = binaryScoreOrNull(row.N_score);
  const i = binaryScoreOrNull(row.I_score);
  const c = binaryScoreOrNull(row.C_score);
  const s = binaryScoreOrNull(row.S_score);
  if (n === null || i === null || c === null || s === null) return null;
  return n + i + c + s;
}

function hasCountedNicsEvidence(row) {
  const score = nicsUnlockScore(row);
  return score === null ? null : score >= 4;
}

function binaryScoreOrNull(value) {
  const score = parseNumber(value);
  if (score === null) return null;
  return score === 1 ? 1 : 0;
}

function isAboveHalfSol(row) {
  const sol = parseNumber(row.sol_invested);
  if (sol === null) return null;
  return sol > 0.5 + 0.0001;
}

function latestRunningCount(history) {
  const latest = [...history]
    .map((row) => ({ row, time: rowDateTimeMs(row) }))
    .filter((entry) => entry.time !== null && parseNumber(entry.row.running_count) !== null)
    .sort((a, b) => b.time - a.time)[0];
  return latest ? (parseNumber(latest.row.running_count) ?? 0) : 0;
}

function fillClusterPnl(rowsToFill, allRows) {
  const pnlByCluster = new Map();
  for (const row of allRows) {
    const clusterId = String(row.meta_cluster_id ?? "").trim();
    const pnl = parseNumber(row.pnl_percentage);
    if (!clusterId || pnl === null) continue;
    const list = pnlByCluster.get(clusterId) ?? [];
    list.push(pnl);
    pnlByCluster.set(clusterId, list);
  }
  for (const row of rowsToFill) {
    if (!isBlank(row.cluster_pnl_pct)) continue;
    const clusterId = String(row.meta_cluster_id ?? "").trim();
    const values = pnlByCluster.get(clusterId) ?? [];
    if (values.length === 0) continue;
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    row.cluster_pnl_pct = String(Math.round(avg));
  }
}

function rowDateTimeMs(row) {
  const serial = parseDateSerial(row.trade_date);
  if (serial === null) return null;
  const time = parseTimeParts(firstNonBlank(row.entry_time_inferred, row.exit_time_actual, row.video_start_time));
  if (!time) return null;
  const date = dateFromExcelSerial(serial);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), time.hour, time.minute, time.second);
}

function parseTimeParts(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  const ampm = match[4]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  return { hour, minute, second };
}

async function importWorkbookRows(source, { allRows, seen }) {
  const rawRows = await readXlsxRows(source.filePath);
  let added = 0;
  let backfilled = 0;
  for (const raw of rawRows) {
    const row = normalizeWorkflowRow(raw, source.sourceSession, source.sourceType, source.filePath);
    const key = rowKey(row);
    if (!seen.has(key)) {
      seen.add(key);
      allRows.push(row);
      added++;
    } else if (backfillMissingNicsFields(allRows, key, row)) {
      backfilled++;
    }
  }
  return {
    sourceSession: source.sourceSession,
    sourceType: source.sourceType,
    sourceFile: source.filePath,
    rowsFound: rawRows.length,
    rowsAdded: added,
    rowsBackfilled: backfilled,
    processedAt: new Date().toISOString(),
  };
}

async function canUpdateExistingWorkbook(filePath) {
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    return Boolean(await worksheetPathForName(zip, "Master Trading Log"));
  } catch {
    return false;
  }
}

async function updateExistingWorkbook(filePath, rows) {
  const original = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(original);
  const masterPath = await worksheetPathForName(zip, "Master Trading Log");
  if (!masterPath) {
    await writeXlsx(filePath, rows);
    return;
  }
  const masterXml = await zip.file(masterPath)?.async("string");
  if (!masterXml) {
    await writeXlsx(filePath, rows);
    return;
  }

  await backupMasterWorkbook(filePath);

  const workbookStylesXml = await zip.file("xl/styles.xml")?.async("string") ?? "";
  const styles = extractWorksheetStyles(masterXml, workbookStylesXml);
  const widths = MASTER_COLUMNS.map((column) => {
    const max = [column, ...rows.map((row) => row[column] ?? "")].reduce((m, value) => {
      return Math.max(m, ...String(value).split(/\r?\n/).map((line) => line.length));
    }, 0);
    return Math.max(8, Math.min(40, max));
  });
  const lastRow = rows.length + 1;
  zip.file(masterPath, worksheetXml(rows, widths, styles));

  await updateWorkbookMetadata(zip, lastRow);
  await removeCalcChain(zip);

  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function appendRowsToExistingWorkbook(filePath, rowsToAppend) {
  const original = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(original);
  const masterPath = await worksheetPathForName(zip, "Master Trading Log");
  if (!masterPath) {
    throw new Error(`Cannot find "Master Trading Log" sheet in ${filePath}.`);
  }
  let masterXml = await zip.file(masterPath)?.async("string");
  if (!masterXml) {
    throw new Error(`Cannot read "Master Trading Log" XML in ${filePath}.`);
  }

  await backupMasterWorkbook(filePath);

  const workbookStylesXml = await zip.file("xl/styles.xml")?.async("string") ?? "";
  const styles = extractWorksheetStyles(masterXml, workbookStylesXml);
  const currentLastRow = worksheetLastRow(masterXml);
  const targetLastRow = currentLastRow + rowsToAppend.length;
  const lastColumn = maxColumnName(worksheetLastColumn(masterXml), columnName(MASTER_COLUMNS.length - 1));
  masterXml = ensureMasterHeaderColumns(masterXml, styles);
  const appendedRows = rowsToAppend.map((row, index) =>
    masterDataRowXml(row, currentLastRow + index + 1, styles)
  ).join("");

  masterXml = masterXml.replace("</sheetData>", `${appendedRows}</sheetData>`);
  masterXml = await normalizeMasterTradeDates(zip, masterXml, styles.date);
  masterXml = updateWorksheetDimension(masterXml, lastColumn, targetLastRow);
  masterXml = removeWorksheetAutoFilter(masterXml);
  zip.file(masterPath, masterXml);

  await updateMasterTable(zip, masterPath, lastColumn, targetLastRow);
  await updateWorkbookMetadata(zip, targetLastRow);
  await removeCalcChain(zip);

  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function ensureMasterHeaderColumns(sheetXml, styles) {
  const headerMatch = sheetXml.match(/<row\b([^>]*)\br="1"([^>]*)>([\s\S]*?)<\/row>/);
  if (!headerMatch) return sheetXml;

  const body = headerMatch[3];
  const existingIndexes = new Set();
  for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const cellRef = cellMatch[1].match(/\br="([^"]+)"/)?.[1] ?? "";
    existingIndexes.add(columnIndex(cellRef));
  }

  const missingCells = [];
  for (let i = 0; i < MASTER_COLUMNS.length; i++) {
    if (!existingIndexes.has(i)) {
      missingCells.push(cell(ref(i, 1), MASTER_COLUMNS[i], styleForHeader(MASTER_COLUMNS[i], styles)));
    }
  }
  if (missingCells.length === 0) return sheetXml;

  const replacement = `<row${headerMatch[1]} r="1"${headerMatch[2]}>${body}${missingCells.join("")}</row>`;
  return sheetXml.replace(headerMatch[0], replacement);
}

async function rewriteExistingMasterWorkbook(filePath, rows) {
  const original = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(original);
  const masterPath = await worksheetPathForName(zip, "Master Trading Log");
  if (!masterPath) {
    throw new Error(`Cannot find "Master Trading Log" sheet in ${filePath}.`);
  }
  let masterXml = await zip.file(masterPath)?.async("string");
  if (!masterXml) {
    throw new Error(`Cannot read "Master Trading Log" XML in ${filePath}.`);
  }

  await backupMasterWorkbook(filePath);

  const workbookStylesXml = await zip.file("xl/styles.xml")?.async("string") ?? "";
  const styles = extractWorksheetStyles(masterXml, workbookStylesXml);
  const lastRow = rows.length + 1;
  const lastColumn = maxColumnName(worksheetLastColumn(masterXml), columnName(MASTER_COLUMNS.length - 1));
  masterXml = ensureMasterHeaderColumns(masterXml, styles);
  const headerRow = masterXml.match(/<row\b[^>]*\br="1"[^>]*>[\s\S]*?<\/row>/)?.[0];
  if (!headerRow) throw new Error("Master sheet is missing header row; refusing to rewrite.");

  const bodyRows = rows.map((row, index) => masterDataRowXml(row, index + 2, styles)).join("");
  masterXml = masterXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${headerRow}${bodyRows}</sheetData>`);
  masterXml = await normalizeMasterTradeDates(zip, masterXml, styles.date);
  masterXml = updateWorksheetDimension(masterXml, lastColumn, lastRow);
  masterXml = removeWorksheetAutoFilter(masterXml);
  zip.file(masterPath, masterXml);

  await updateMasterTable(zip, masterPath, lastColumn, lastRow);
  await updateWorkbookMetadata(zip, lastRow);
  await removeCalcChain(zip);
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function repairExistingWorkbook(filePath) {
  const original = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(original);
  const masterPath = await worksheetPathForName(zip, "Master Trading Log");
  if (!masterPath) return false;

  let changed = false;
  let masterXml = await zip.file(masterPath)?.async("string");
  if (masterXml) {
    const workbookStylesXml = await zip.file("xl/styles.xml")?.async("string") ?? "";
    const styles = extractWorksheetStyles(masterXml, workbookStylesXml);
    const repairedMasterXml = await normalizeMasterTradeDates(zip, masterXml, styles.date);
    const repairedXml = removeWorksheetAutoFilter(repairedMasterXml);
    if (repairedXml !== masterXml) {
      masterXml = repairedXml;
      zip.file(masterPath, masterXml);
      changed = true;
    }
  }

  if (!changed) return false;
  await backupMasterWorkbook(filePath);
  await updateWorkbookMetadata(zip, worksheetLastRow(masterXml ?? ""));
  await removeCalcChain(zip);
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return true;
}

async function normalizeMasterTradeDates(zip, masterXml, dateStyle) {
  const sharedStrings = await readSharedStrings(zip);
  return masterXml.replace(/<c\b([^>]*\br="G(\d+)"[^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g, (full, attrs, rowText, content = "") => {
    const row = Number(rowText);
    if (row < 2) return full;
    const serial = parseDateSerial(cellScalarValue(attrs, content, sharedStrings));
    if (serial === null) return full;
    return `<c r="G${row}" s="${dateStyle ?? 14}"><v>${serial}</v></c>`;
  });
}

function cellScalarValue(attrs, content, sharedStrings) {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "";
  const value = content.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
  if (type === "s" && value !== "") return sharedStrings[Number(value)] ?? "";
  const textPieces = [...content.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1]));
  if (textPieces.length > 0) return textPieces.join("");
  return xmlDecode(value);
}

async function backupMasterWorkbook(filePath) {
  const backupDir = path.join(ARCHIVE, "master trading log backups");
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.copyFile(filePath, path.join(backupDir, `master trading log before sync ${stamp}.xlsx`));
}

function extractWorksheetStyles(sheetXml, workbookStylesXml = "") {
  const styles = {
    header: 1,
    text: 2,
    integer: 3,
    wholeNumber: 4,
    decimal: 5,
    percent: 6,
    date: findDateStyleIndex(workbookStylesXml) ?? 7,
    headers: {},
    data: {},
  };

  const headerRow = sheetXml.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/)?.[1] ?? "";
  for (const match of headerRow.matchAll(/<c\b([^>]*)\/?>/g)) {
    const cellRef = match[1].match(/\br="([^"]+)"/)?.[1] ?? "";
    const col = columnIndex(cellRef);
    const style = match[1].match(/\bs="(\d+)"/)?.[1];
    if (col >= 0 && MASTER_COLUMNS[col] && style) styles.headers[MASTER_COLUMNS[col]] = Number(style);
  }

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    if (rowNumber < 2 || rowNumber > 20) continue;
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)\/?>/g)) {
      const cellRef = cellMatch[1].match(/\br="([^"]+)"/)?.[1] ?? "";
      const col = columnIndex(cellRef);
      const style = cellMatch[1].match(/\bs="(\d+)"/)?.[1];
      if (col >= 0 && MASTER_COLUMNS[col] && style && !styles.data[MASTER_COLUMNS[col]]) {
        styles.data[MASTER_COLUMNS[col]] = Number(style);
      }
    }
  }

  styles.header = styles.headers.source_session ?? styles.header;
  styles.text = styles.data.token_name ?? styles.text;
  styles.integer = styles.data.trade_id ?? styles.integer;
  styles.wholeNumber = styles.data.entry_mc_actual ?? styles.wholeNumber;
  styles.decimal = styles.data.sol_invested ?? styles.decimal;
  styles.percent = styles.data.pnl_percentage ?? styles.percent;
  return styles;
}

function findDateStyleIndex(stylesXml) {
  if (!stylesXml) return null;
  const customFormats = new Map(
    [...stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="([^"]+)"[^>]*formatCode="([^"]+)"/g)]
      .map((match) => [match[1], xmlDecode(match[2])])
  );
  const cellXfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const xfs = [...cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)];
  for (let index = 0; index < xfs.length; index++) {
    const numFmtId = xfs[index][1].match(/\bnumFmtId="([^"]+)"/)?.[1] ?? "";
    const format = customFormats.get(numFmtId) ?? "";
    if (isDateNumFmt(numFmtId, format)) return index;
  }
  return null;
}

function isDateNumFmt(numFmtId, formatCode) {
  if (["14", "15", "16", "17", "22"].includes(String(numFmtId))) return true;
  const format = String(formatCode ?? "")
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  return /[ymd]/.test(format) && !/[hs]/.test(format);
}

async function extendFormulaSheets(zip, masterLastRow, skipSheetNames = []) {
  const ranges = [];
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  if (!workbook) return ranges;

  for (const sheetMatch of workbook.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const sheetName = xmlDecode(sheetMatch[1].match(/\bname="([^"]+)"/)?.[1] ?? "");
    if (skipSheetNames.includes(sheetName)) continue;
    const sheetPath = await worksheetPathForName(zip, sheetName);
    if (!sheetPath) continue;
    const file = zip.file(sheetPath);
    if (!file) continue;
    let sheetXml = await file.async("string");
    if (!/<f\b/.test(sheetXml)) continue;

    const currentLastRow = worksheetLastRow(sheetXml);
    const targetLastRow = Math.max(currentLastRow, masterLastRow);
    const lastColumn = worksheetLastColumn(sheetXml);
    ranges.push({ sheetName, oldLastRow: currentLastRow, newLastRow: targetLastRow });

    if (targetLastRow > currentLastRow) {
      sheetXml = extendFormulaSheetXml(sheetXml, currentLastRow, targetLastRow);
    }

    sheetXml = sheetXml.replace(
      /<dimension\b[^>]*\bref="[^"]+"\/>/,
      `<dimension ref="A1:${lastColumn}${targetLastRow}"/>`
    );
    zip.file(sheetPath, sheetXml);
  }
  return ranges;
}

function worksheetLastRow(sheetXml) {
  let last = 1;
  for (const match of sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) {
    last = Math.max(last, Number(match[1]));
  }
  return last;
}

function worksheetLastColumn(sheetXml) {
  const dimensionColumn = sheetXml.match(/<dimension\b[^>]*\bref="A1:([A-Z]+)\d+"/)?.[1];
  if (dimensionColumn) return dimensionColumn;
  let last = 0;
  for (const match of sheetXml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) {
    last = Math.max(last, columnIndex(match[1]));
  }
  return columnName(last);
}

function columnName(columnIndex) {
  let name = "";
  let n = columnIndex + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function maxColumnName(a, b) {
  return columnIndex(`${a}1`) >= columnIndex(`${b}1`) ? a : b;
}

function updateWorksheetDimension(sheetXml, lastColumn, lastRow) {
  const dimension = `<dimension ref="A1:${lastColumn}${lastRow}"/>`;
  if (/<dimension\b[^>]*\/>/.test(sheetXml)) {
    return sheetXml.replace(/<dimension\b[^>]*\/>/, dimension);
  }
  return sheetXml.replace(/<worksheet\b([^>]*)>/, `<worksheet$1>${dimension}`);
}

function updateWorksheetAutoFilter(sheetXml, lastColumn, lastRow) {
  const autoFilter = `<autoFilter ref="A1:${lastColumn}${lastRow}"/>`;
  if (/<autoFilter\b[^>]*\/>/.test(sheetXml)) {
    return sheetXml.replace(/<autoFilter\b[^>]*\/>/, autoFilter);
  }
  if (/<sheetData>[\s\S]*<\/sheetData>/.test(sheetXml)) {
    return sheetXml.replace(/(<\/sheetData>)/, `$1${autoFilter}`);
  }
  return sheetXml;
}

function removeWorksheetAutoFilter(sheetXml) {
  return sheetXml.replace(/<autoFilter\b[^>]*(?:\/>|>[\s\S]*?<\/autoFilter>)/g, "");
}

async function updateMasterTable(zip, masterPath, lastColumn, lastRow) {
  const relsPath = worksheetRelsPath(masterPath);
  const relsFile = zip.file(relsPath);
  if (!relsFile) {
    throw new Error(`Master sheet has no relationship file (${relsPath}); refusing to append because tblTrades cannot be updated.`);
  }

  const relsXml = await relsFile.async("string");
  const tableTargets = [...relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => {
      const attrs = match[1];
      const type = attrs.match(/\bType="([^"]+)"/)?.[1] ?? "";
      const target = attrs.match(/\bTarget="([^"]+)"/)?.[1] ?? "";
      if (!type.endsWith("/table") || !target) return null;
      return normalizePartPath(path.posix.dirname(masterPath), target);
    })
    .filter(Boolean);

  if (tableTargets.length !== 1) {
    throw new Error(`Expected exactly one table relationship for Master Trading Log; found ${tableTargets.length}. Refusing to write.`);
  }

  const tablePath = tableTargets[0];
  const tableFile = zip.file(tablePath);
  if (!tableFile) {
    throw new Error(`Master table part ${tablePath} is missing. Refusing to write.`);
  }

  let tableXml = await tableFile.async("string");
  const displayName = tableXml.match(/\bdisplayName="([^"]+)"/)?.[1] ?? "";
  if (displayName !== "tblTrades") {
    throw new Error(`Expected master table displayName="tblTrades"; found "${displayName}". Refusing to write.`);
  }

  const columnCount = Number(tableXml.match(/<tableColumns\b[^>]*\bcount="(\d+)"/)?.[1] ?? 0);
  if (columnCount > MASTER_COLUMNS.length) {
    throw new Error(`tblTrades has ${columnCount} columns, but importer expects ${MASTER_COLUMNS.length}. Refusing to write.`);
  }
  if (columnCount < MASTER_COLUMNS.length) {
    tableXml = extendMasterTableColumns(tableXml, columnCount);
  }

  const tableRef = `A1:${lastColumn}${lastRow}`;
  tableXml = tableXml
    .replace(/\bref="[^"]+"/, `ref="${tableRef}"`)
    .replace(/<autoFilter\b([^>]*)\bref="[^"]+"/, `<autoFilter$1ref="${tableRef}"`);
  zip.file(tablePath, tableXml);
}

async function extendAnalysisForMasterRows(zip, targetLastRow) {
  const analysisPath = await worksheetPathForName(zip, "Analysis");
  if (!analysisPath) return;
  let analysisXml = await zip.file(analysisPath)?.async("string");
  if (!analysisXml) return;
  analysisXml = materializeSharedFormulas(analysisXml);

  const tableInfo = await tableInfoForSheet(zip, analysisPath, "tblAnalysis");
  const currentTableLastRow = tableInfo.ref.match(/:(?:[A-Z]+)(\d+)$/)?.[1];
  const tableLastRow = Number(currentTableLastRow ?? 1);
  if (targetLastRow <= tableLastRow) return;

  analysisXml = fillAnalysisTableRows(analysisXml, tableLastRow, targetLastRow);
  const currentSheetLastRow = worksheetLastRow(analysisXml);
  if (targetLastRow > currentSheetLastRow) {
    analysisXml = extendFormulaSheetXml(analysisXml, currentSheetLastRow, targetLastRow);
    analysisXml = updateWorksheetDimension(analysisXml, worksheetLastColumn(analysisXml), targetLastRow);
  }
  zip.file(analysisPath, analysisXml);

  await updateTableRange(zip, tableInfo.path, "tblAnalysis", "A1", `O${targetLastRow}`, 15);
}

async function tableInfoForSheet(zip, sheetPath, displayName) {
  const relsPath = worksheetRelsPath(sheetPath);
  const relsXml = await zip.file(relsPath)?.async("string");
  if (!relsXml) {
    throw new Error(`Sheet ${sheetPath} has no relationship file (${relsPath}); cannot locate ${displayName}.`);
  }

  const tablePaths = [...relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map((match) => {
      const attrs = match[1];
      const type = attrs.match(/\bType="([^"]+)"/)?.[1] ?? "";
      const target = attrs.match(/\bTarget="([^"]+)"/)?.[1] ?? "";
      if (!type.endsWith("/table") || !target) return null;
      return normalizePartPath(path.posix.dirname(sheetPath), target);
    })
    .filter(Boolean);

  for (const tablePath of tablePaths) {
    const tableXml = await zip.file(tablePath)?.async("string");
    if (!tableXml) continue;
    const name = tableXml.match(/\bdisplayName="([^"]+)"/)?.[1] ?? "";
    if (name === displayName) {
      return {
        path: tablePath,
        xml: tableXml,
        ref: tableXml.match(/<table\b[^>]*\bref="([^"]+)"/)?.[1] ?? "",
      };
    }
  }
  throw new Error(`Could not find table ${displayName} related to ${sheetPath}.`);
}

async function updateTableRange(zip, tablePath, displayName, startRef, endRef, expectedColumns) {
  const tableFile = zip.file(tablePath);
  if (!tableFile) throw new Error(`Table part ${tablePath} is missing.`);
  let tableXml = await tableFile.async("string");
  const foundName = tableXml.match(/\bdisplayName="([^"]+)"/)?.[1] ?? "";
  if (foundName !== displayName) {
    throw new Error(`Expected table ${displayName}; found ${foundName}.`);
  }
  const columnCount = Number(tableXml.match(/<tableColumns\b[^>]*\bcount="(\d+)"/)?.[1] ?? 0);
  if (columnCount !== expectedColumns) {
    throw new Error(`${displayName} has ${columnCount} columns, expected ${expectedColumns}.`);
  }
  const ref = `${startRef}:${endRef}`;
  tableXml = tableXml
    .replace(/\bref="[^"]+"/, `ref="${ref}"`)
    .replace(/<autoFilter\b([^>]*)\bref="[^"]+"/, `<autoFilter$1ref="${ref}"`);
  zip.file(tablePath, tableXml);
}

function extendMasterTableColumns(tableXml, existingColumnCount) {
  const existingNames = [
    ...tableXml.matchAll(/<tableColumn\b([^>]*)/g),
  ].map((match) => xmlDecode(match[1].match(/\bname="([^"]*)"/)?.[1] ?? ""));
  for (let i = 0; i < existingColumnCount; i++) {
    if (existingNames[i] !== MASTER_COLUMNS[i]) {
      throw new Error(`tblTrades column ${i + 1} is "${existingNames[i]}", expected "${MASTER_COLUMNS[i]}". Refusing to extend schema.`);
    }
  }

  const appended = [];
  for (let i = existingColumnCount; i < MASTER_COLUMNS.length; i++) {
    appended.push(`<tableColumn id="${i + 1}" name="${xml(MASTER_COLUMNS[i])}"/>`);
  }

  if (/<tableColumns\b[^>]*>[\s\S]*?<\/tableColumns>/.test(tableXml)) {
    return tableXml
      .replace(/<tableColumns\b([^>]*)\bcount="\d+"/, `<tableColumns$1count="${MASTER_COLUMNS.length}"`)
      .replace(/<\/tableColumns>/, `${appended.join("")}</tableColumns>`);
  }

  throw new Error("tblTrades has no tableColumns block; refusing to extend schema.");
}

function fillAnalysisTableRows(sheetXml, currentTableLastRow, targetLastRow) {
  const template = findAnalysisTemplateRow(sheetXml, Math.min(currentTableLastRow, targetLastRow));
  if (!template) return sheetXml;
  const sharedFormulas = collectSharedFormulas(sheetXml);
  const lastTemplateColumn = lastColumnIndexInRow(template.body);
  let out = sheetXml;
  const firstRowToFill = Math.min(currentTableLastRow + 1, template.row + 1);
  for (let row = firstRowToFill; row <= targetLastRow; row++) {
    const rowXml = clonedAnalysisRowXml(template, row, sharedFormulas, lastTemplateColumn);
    const existingMatch = out.match(new RegExp(`<row\\b([^>]*)\\br="${row}"([^>]*)>([\\s\\S]*?)<\\/row>`));
    if (existingMatch) {
      out = out.replace(existingMatch[0], rowXml);
    } else {
      out = out.replace("</sheetData>", `${rowXml}</sheetData>`);
    }
  }
  return out;
}

function findAnalysisTemplateRow(sheetXml, preferredRow) {
  for (let row = preferredRow; row >= 2; row--) {
    const match = sheetXml.match(new RegExp(`<row\\b([^>]*)\\br="${row}"([^>]*)>([\\s\\S]*?)<\\/row>`));
    if (match && isAlignedAnalysisHelperRow(match[3], row)) {
      return {
        row,
        attrs: `${match[1]} ${match[2]}`.trim(),
        body: match[3],
      };
    }
  }
  return findTemplateRow(sheetXml, preferredRow);
}

function isAlignedAnalysisHelperRow(rowBody, row) {
  const ak = formulaTextForCell(rowBody, `AK${row}`);
  const al = formulaTextForCell(rowBody, `AL${row}`);
  const am = formulaTextForCell(rowBody, `AM${row}`);
  const ap = formulaTextForCell(rowBody, `AP${row}`);
  const aq = formulaTextForCell(rowBody, `AQ${row}`);
  const ar = formulaTextForCell(rowBody, `AR${row}`);
  const as = formulaTextForCell(rowBody, `AS${row}`);
  return (
    ak.includes("INDEX($A:$A,ROW())") &&
    al.includes("tblTrades[sol_invested]") &&
    am.includes("tblAnalysis[P&L SOL]") &&
    ap.includes("tblAnalysis[Entry MC ($)]") &&
    aq.includes("tblAnalysis[P&L %]") &&
    ar.includes("tblAnalysis[Hold Time (s)]") &&
    as.includes("tblAnalysis[P&L SOL]")
  );
}

function formulaTextForCell(rowBody, cellRef) {
  const cell = rowBody.match(new RegExp(`<c\\b[^>]*\\br="${cellRef}"[^>]*(?:\\/>|>([\\s\\S]*?)<\\/c>)`));
  if (!cell?.[1]) return "";
  const formula = cell[1].match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1] ?? "";
  return xmlDecode(formula);
}

function lastColumnIndexInRow(rowBody) {
  let last = 0;
  for (const match of rowBody.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) {
    last = Math.max(last, columnIndex(match[1]));
  }
  return last;
}

function clonedAnalysisRowXml(template, targetRow, sharedFormulas, lastColumnIndex) {
  const rowAttrs = template.attrs
    .replace(/\br="\d+"/g, "")
    .replace(/\bspans="[^"]*"/g, "")
    .replace(/\bht="[^"]*"/g, "")
    .replace(/\bcustomHeight="[^"]*"/g, "");
  const cells = cloneRowCellsForColumns(template, targetRow, sharedFormulas, 0, lastColumnIndex);
  const attrText = rowAttrs.trim();
  return `<row r="${targetRow}"${attrText ? ` ${attrText}` : ""}>${cells}</row>`;
}

function cloneRowCellsForColumns(template, targetRow, sharedFormulas, startColumnIndex, endColumnIndex) {
  return [...template.body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
    .map((match) => {
      const attrs = match[1];
      const content = match[2] ?? "";
      const sourceRef = attrs.match(/\br="([^"]+)"/)?.[1] ?? "";
      const column = sourceRef.match(/[A-Z]+/)?.[0] ?? "";
      const colIndex = columnIndex(`${column}1`);
      if (colIndex < startColumnIndex || colIndex > endColumnIndex) return "";
      const targetRef = `${column}${targetRow}`;
      const newAttrs = attrs
        .replace(/\br="[^"]+"/, `r="${targetRef}"`)
        .replace(/\bcm="[^"]*"/g, "")
        .replace(/\bt="s"/, 't="str"');
      const formula = formulaForClonedCell(content, targetRow, sharedFormulas, template.row);
      if (formula !== null) return `<c${formulaCellAttrs(newAttrs)}><f>${xml(formula)}</f></c>`;
      return `<c${newAttrs}/>`;
    })
    .join("");
}

function worksheetRelsPath(worksheetPath) {
  const dir = path.posix.dirname(worksheetPath);
  const base = path.posix.basename(worksheetPath);
  return `${dir}/_rels/${base}.rels`;
}

function normalizePartPath(baseDir, target) {
  if (target.startsWith("/")) return target.replace(/^\//, "");
  return path.posix.normalize(path.posix.join(baseDir, target));
}

function extendFormulaSheetXml(sheetXml, currentLastRow, targetLastRow) {
  const template = findTemplateRow(sheetXml, currentLastRow);
  if (!template) return sheetXml;
  const sharedFormulas = collectSharedFormulas(sheetXml);
  const rows = [];
  for (let row = currentLastRow + 1; row <= targetLastRow; row++) {
    rows.push(cloneFormulaRow(template, row, sharedFormulas));
  }
  return sheetXml.replace("</sheetData>", `${rows.join("")}</sheetData>`);
}

function findTemplateRow(sheetXml, preferredRow) {
  for (let row = preferredRow; row >= 2; row--) {
    const match = sheetXml.match(new RegExp(`<row\\b([^>]*)\\br="${row}"([^>]*)>([\\s\\S]*?)<\\/row>`));
    if (match && /<f\b/.test(match[3])) {
      return {
        row,
        attrs: `${match[1]} ${match[2]}`.trim(),
        body: match[3],
      };
    }
  }
  return null;
}

function collectSharedFormulas(sheetXml) {
  const formulas = new Map();
  for (const cellMatch of sheetXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const cellRef = cellMatch[1].match(/\br="([^"]+)"/)?.[1] ?? "";
    const formulaMatch = cellMatch[2].match(/<f\b([^>]*)>([\s\S]*?)<\/f>/);
    if (!formulaMatch) continue;
    const attrs = formulaMatch[1];
    const si = attrs.match(/\bsi="([^"]+)"/)?.[1];
    const formula = formulaMatch[2];
    if (si !== undefined && formula) {
      formulas.set(si, { formula: xmlDecode(formula), cellRef, row: Number(cellRef.match(/\d+/)?.[0] ?? 1) });
    }
  }
  return formulas;
}

function materializeSharedFormulas(sheetXml) {
  const sharedFormulas = collectSharedFormulas(sheetXml);
  return sheetXml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (full, attrs, content = "") => {
    if (!/<f\b/.test(content)) return full;
    const cellRef = attrs.match(/\br="([^"]+)"/)?.[1] ?? "";
    const body = content.replace(/<f\b([^>]*?)>([\s\S]*?)<\/f>|<f\b([^>]*?)\/>/g, (formulaFull, formulaAttrs = "", formulaText = "", emptyAttrs = "") => {
      const attrsText = formulaAttrs || emptyAttrs || "";
      if (!/\bt="shared"|\bsi="/.test(attrsText)) return formulaFull;
      const si = attrsText.match(/\bsi="([^"]+)"/)?.[1];
      const shared = si === undefined ? null : sharedFormulas.get(si);
      const sourceFormula = formulaText ? xmlDecode(formulaText) : shared?.formula ?? "";
      const sourceRef = formulaText ? cellRef : shared?.cellRef ?? cellRef;
      return sourceFormula ? `<f>${xml(translateFormula(sourceFormula, sourceRef, cellRef))}</f>` : "";
    });
    return `<c${formulaCellAttrs(attrs)}>${withoutCachedFormulaValue(body)}</c>`;
  });
}

function cloneFormulaRow(template, targetRow, sharedFormulas) {
  const rowAttrs = template.attrs
    .replace(/\br="\d+"/g, "")
    .replace(/\bspans="[^"]*"/g, "")
    .replace(/\bht="[^"]*"/g, "")
    .replace(/\bcustomHeight="[^"]*"/g, "");
  const body = template.body.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (full, attrs, content = "") => {
    const sourceRef = attrs.match(/\br="([^"]+)"/)?.[1] ?? "";
    const column = sourceRef.match(/[A-Z]+/)?.[0] ?? "";
    if (!column) return "";
    const targetRef = `${column}${targetRow}`;
    const newAttrs = attrs
      .replace(/\br="[^"]+"/, `r="${targetRef}"`)
      .replace(/\bt="s"/, 't="str"');
    const formula = formulaForClonedCell(content, targetRow, sharedFormulas, template.row);
    if (formula !== null) {
      return `<c${formulaCellAttrs(newAttrs)}><f>${xml(formula)}</f></c>`;
    }
    const text = stringValueForClonedCell(content);
    if (text === null) return `<c${newAttrs}/>`;
    return `<c${newAttrs}>${text}</c>`;
  });
  const attrText = rowAttrs.trim();
  return `<row r="${targetRow}"${attrText ? ` ${attrText}` : ""}>${body}</row>`;
}

function formulaForClonedCell(content, targetRow, sharedFormulas, templateRow = 0) {
  const formulaMatch = content.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/);
  const emptySharedMatch = content.match(/<f\b([^>]*)\/>/);
  if (!formulaMatch && !emptySharedMatch) return null;
  const attrs = formulaMatch?.[1] ?? emptySharedMatch?.[1] ?? "";
  const formulaText = formulaMatch?.[2] ? xmlDecode(formulaMatch[2]) : "";
  const sourceRow = Number((attrs.match(/\bref="[A-Z]+(\d+):/) ?? [])[1] ?? 0);
  if (formulaText) {
    const baseRow = sourceRow || templateRow || targetRow - 1;
    return translateFormulaRows(formulaText, targetRow - baseRow);
  }
  const si = attrs.match(/\bsi="([^"]+)"/)?.[1];
  const shared = si === undefined ? null : sharedFormulas.get(si);
  if (!shared) return "";
  return translateFormulaRows(shared.formula, targetRow - shared.row);
}

function formulaCellAttrs(attrs) {
  return attrs
    .replace(/\bt="[^"]*"/g, "")
    .replace(/\bcm="[^"]*"/g, "");
}

function withoutCachedFormulaValue(content) {
  return content.replace(/<v>[\s\S]*?<\/v>/g, "");
}

function stringValueForClonedCell(content) {
  if (!content || /<v>/.test(content)) return null;
  return content;
}

function translateFormulaRows(formula, delta) {
  if (!delta) return formula;
  return translateFormula(formula, "A1", `A${1 + delta}`);
}

function translateFormula(formula, sourceRef, targetRef) {
  const source = splitCellRef(sourceRef);
  const target = splitCellRef(targetRef);
  if (!source || !target) return formula;
  const rowDelta = target.row - source.row;
  const colDelta = target.col - source.col;
  return formula.replace(/((?:'[^']+'|[A-Za-z_][A-Za-z0-9_ ]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (match, sheet, colAbs, col, rowAbs, row) => {
    const translatedColIndex = columnIndex(`${col}1`) + colDelta;
    if (translatedColIndex < 0) return match;
    const translatedCol = colAbs === "$" ? col : columnName(translatedColIndex);
    const translatedRow = rowAbs === "$" ? Number(row) : Number(row) + rowDelta;
    if (translatedRow < 1) return match;
    return `${sheet ?? ""}${colAbs}${translatedCol}${rowAbs}${translatedRow}`;
  });
}

function splitCellRef(cellRef) {
  const match = String(cellRef ?? "").match(/^([A-Z]{1,3})(\d+)$/);
  if (!match) return null;
  return { col: columnIndex(`${match[1]}1`), row: Number(match[2]) };
}

function formulaCell(cellRef, formula, style, stringResult) {
  const styleAttr = style ? ` s="${style}"` : "";
  const typeAttr = stringResult ? ` t="str"` : "";
  return `<c r="${cellRef}"${styleAttr}${typeAttr}><f>${xml(formula)}</f></c>`;
}

async function updateWorkbookMetadata(zip, masterLastRow) {
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) return;
  let workbook = await workbookFile.async("string");
  const lastMasterColumn = columnName(MASTER_COLUMNS.length - 1);
  workbook = workbook.replace(/'Master Trading Log'!\$A\$1:\$[A-Z]+\$\d+/g, `'Master Trading Log'!$A$1:$${lastMasterColumn}$${masterLastRow}`);
  if (/<calcPr\b[^>]*\/>/.test(workbook)) {
    workbook = workbook.replace(/<calcPr\b[^>]*\/>/, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>');
  } else if (/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/.test(workbook)) {
    workbook = workbook.replace(/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>');
  } else {
    workbook = workbook.replace("</workbook>", '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
  }
  zip.file("xl/workbook.xml", workbook);
}

async function updateChartRanges(zip, formulaSheetRanges) {
  for (const entryName of Object.keys(zip.files)) {
    if (!entryName.startsWith("xl/charts/") || !entryName.endsWith(".xml")) continue;
    const file = zip.file(entryName);
    if (!file) continue;
    let xmlText = await file.async("string");
    for (const range of formulaSheetRanges) {
      xmlText = updateSheetBoundedRows(xmlText, range.sheetName, range.oldLastRow, range.newLastRow);
    }
    zip.file(entryName, xmlText);
  }
}

function updateSheetBoundedRows(text, sheetName, oldLastRow, newLastRow) {
  if (oldLastRow === newLastRow) return text;
  const escapedSheet = sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedSheet = `'${escapedSheet}'`;
  return text.replace(
    new RegExp(`((?:${escapedSheet}|${quotedSheet})!\\$?[A-Z]{1,3}\\$?2:\\$?[A-Z]{1,3}\\$?)${oldLastRow}\\b`, "g"),
    `$1${newLastRow}`
  );
}

async function removeCalcChain(zip) {
  zip.remove("xl/calcChain.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (relsFile) {
    const rels = await relsFile.async("string");
    zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ""));
  }
  const typesFile = zip.file("[Content_Types].xml");
  if (typesFile) {
    const types = await typesFile.async("string");
    zip.file("[Content_Types].xml", types.replace(/<Override PartName="\/xl\/calcChain.xml"[^>]*\/>/g, ""));
  }
}

async function writeXlsx(filePath, rows) {
  const widths = MASTER_COLUMNS.map((column) => {
    const max = [column, ...rows.map((row) => row[column] ?? "")].reduce((m, value) => {
      return Math.max(m, ...String(value).split(/\r?\n/).map((line) => line.length));
    }, 0);
    return Math.max(8, Math.min(40, max));
  });
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels")?.file(".rels", rootRelsXml());
  const xl = zip.folder("xl");
  xl?.file("workbook.xml", workbookXml());
  xl?.file("styles.xml", stylesXml());
  xl?.folder("_rels")?.file("workbook.xml.rels", workbookRelsXml());
  xl?.folder("worksheets")?.file("sheet1.xml", worksheetXml(rows, widths));
  zip.folder("docProps")?.file("app.xml", appPropsXml());
  zip.folder("docProps")?.file("core.xml", corePropsXml());
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function writeTradeLogRowsXlsx(filePath, rows) {
  const widths = TRADE_LOG_COLUMNS.map((column) => {
    const max = [column, ...rows.map((row) => row[column] ?? "")].reduce((m, value) => {
      return Math.max(m, ...String(value).split(/\r?\n/).map((line) => line.length));
    }, 0);
    return Math.max(8, Math.min(40, max));
  });
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels")?.file(".rels", rootRelsXml());
  const xl = zip.folder("xl");
  xl?.file("workbook.xml", workbookXml("Trade Log"));
  xl?.file("styles.xml", stylesXml());
  xl?.folder("_rels")?.file("workbook.xml.rels", workbookRelsXml());
  xl?.folder("worksheets")?.file("sheet1.xml", worksheetXmlForColumns(rows, TRADE_LOG_COLUMNS, widths));
  zip.folder("docProps")?.file("app.xml", appPropsXml());
  zip.folder("docProps")?.file("core.xml", corePropsXml());
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

function worksheetXml(rows, widths, styles = null) {
  const styleMap = styles ?? defaultStyleMap();
  const header = MASTER_COLUMNS.map((column, i) => cell(ref(i, 1), column, styleForHeader(column, styleMap))).join("");
  const body = rows.map((row, rowIndex) => masterDataRowXml(row, rowIndex + 2, styleMap)).join("");
  const cols = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${ref(MASTER_COLUMNS.length - 1, Math.max(1, rows.length + 1))}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData><row r="1">${header}</row>${body}</sheetData>
  <autoFilter ref="A1:${ref(MASTER_COLUMNS.length - 1, Math.max(1, rows.length + 1))}"/>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function worksheetXmlForColumns(rows, columns, widths) {
  const header = columns.map((column, i) => cell(ref(i, 1), column, 1)).join("");
  const body = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const values = columns.map((column, i) =>
      typedTradeLogCell(ref(i, rowNumber), column, row[column] ?? "")
    ).join("");
    const lines = Math.max(1, ...columns.map((column) => String(row[column] ?? "").split(/\r?\n/).length));
    return `<row r="${rowNumber}" ht="${Math.min(120, lines * 15)}" customHeight="1">${values}</row>`;
  }).join("");
  const cols = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${ref(columns.length - 1, Math.max(1, rows.length + 1))}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData><row r="1">${header}</row>${body}</sheetData>
  <autoFilter ref="A1:${ref(columns.length - 1, Math.max(1, rows.length + 1))}"/>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function typedTradeLogCell(cellRef, column, value) {
  if (DATE_COLUMNS.has(column)) return dateCell(cellRef, parseDateSerial(value), 7);
  if (INTEGER_COLUMNS.has(column)) return numericCell(cellRef, parseNumber(value), 3);
  if (WHOLE_NUMBER_COLUMNS.has(column)) return numericCell(cellRef, parseNumber(value), 4);
  if (DECIMAL_COLUMNS.has(column)) return numericCell(cellRef, parseNumber(value), 5);
  if (BOOLEAN_COLUMNS.has(column) || column === "needs_review") return booleanCell(cellRef, parseBoolean(value), 2);
  return cell(cellRef, value, 2);
}

function masterDataRowXml(row, rowNumber, styleMap) {
  const values = MASTER_COLUMNS.map((column, i) =>
    typedCell(ref(i, rowNumber), column, row[column] ?? "", styleMap)
  ).join("");
  const lines = Math.max(1, ...MASTER_COLUMNS.map((column) => String(row[column] ?? "").split(/\r?\n/).length));
  return `<row r="${rowNumber}" ht="${Math.min(120, lines * 15)}" customHeight="1">${values}</row>`;
}

function cell(cellRef, value, style) {
  return `<c r="${cellRef}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function defaultStyleMap() {
  return { header: 1, text: 2, integer: 3, wholeNumber: 4, decimal: 5, percent: 6, date: 7, headers: {}, data: {} };
}

function styleForHeader(column, styles) {
  return styles.headers?.[column] ?? styles.header ?? 1;
}

function typedCell(cellRef, column, value, styles = defaultStyleMap()) {
  if (DATE_COLUMNS.has(column)) return dateCell(cellRef, parseDateSerial(value), styles.date ?? 14);
  if (INTEGER_COLUMNS.has(column)) return numericCell(cellRef, parseNumber(value), styles.data?.[column] ?? styles.integer ?? 3);
  if (WHOLE_NUMBER_COLUMNS.has(column)) return numericCell(cellRef, parseNumber(value), styles.data?.[column] ?? styles.wholeNumber ?? 4);
  if (DECIMAL_COLUMNS.has(column)) return numericCell(cellRef, parseNumber(value), styles.data?.[column] ?? styles.decimal ?? 5);
  if (BOOLEAN_COLUMNS.has(column)) return booleanCell(cellRef, parseBoolean(value), styles.data?.[column] ?? styles.text ?? 2);
  if (PERCENT_COLUMNS.has(column)) return pnlPercentageCell(cellRef, styles.data?.[column] ?? styles.percent ?? 6);
  if (column === "Hour") return formulaColumnCell(cellRef, hourFormula(cellRef), styles.data?.[column] ?? styles.text ?? 2, false);
  if (column === "Weekday") return formulaColumnCell(cellRef, weekdayFormula(cellRef), styles.data?.[column] ?? styles.text ?? 2, true);
  if (column === "WeekdayNum") return formulaColumnCell(cellRef, weekdayNumFormula(cellRef), styles.data?.[column] ?? styles.text ?? 2, false);
  if (column === "TimeBucket") return formulaColumnCell(cellRef, timeBucketFormula(cellRef), styles.data?.[column] ?? styles.text ?? 2, true);
  return cell(cellRef, value, styles.data?.[column] ?? styles.text ?? 2);
}

function numericCell(cellRef, value, style) {
  if (value === null) return `<c r="${cellRef}" s="${style}"/>`;
  return `<c r="${cellRef}" s="${style}"><v>${value}</v></c>`;
}

function dateCell(cellRef, value, style) {
  if (value === null) return `<c r="${cellRef}" s="${style}"/>`;
  return `<c r="${cellRef}" s="${style}"><v>${value}</v></c>`;
}

function booleanCell(cellRef, value, style) {
  if (value === null) return `<c r="${cellRef}" s="${style}"/>`;
  return `<c r="${cellRef}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
}

function pnlPercentageCell(cellRef, style) {
  const row = Number(cellRef.match(/\d+/)?.[0] ?? 0);
  if (!row) return `<c r="${cellRef}" s="${style}"/>`;
  return formulaColumnCell(cellRef, `IFERROR(V${row}/T${row},"")`, style, false);
}

function formulaColumnCell(cellRef, formula, style, stringResult) {
  const typeAttr = stringResult ? ' t="str"' : "";
  return `<c r="${cellRef}" s="${style}"${typeAttr}><f>${xml(formula)}</f></c>`;
}

function rowNumberFromRef(cellRef) {
  return Number(cellRef.match(/\d+/)?.[0] ?? 0);
}

function hourFormula(cellRef) {
  const row = rowNumberFromRef(cellRef);
  return `IFERROR(HOUR(IFERROR(IFERROR(IFERROR(TIMEVALUE(J${row}),TIMEVALUE(I${row})),TIMEVALUE(L${row})),TIMEVALUE(H${row}))),"")`;
}

function weekdayFormula(cellRef) {
  const row = rowNumberFromRef(cellRef);
  return `IFERROR(TEXT(IF(ISNUMBER(G${row}),G${row},DATEVALUE(G${row})),"ddd"),"")`;
}

function weekdayNumFormula(cellRef) {
  const row = rowNumberFromRef(cellRef);
  return `IFERROR(WEEKDAY(IF(ISNUMBER(G${row}),G${row},DATEVALUE(G${row})),2),"")`;
}

function timeBucketFormula(cellRef) {
  const row = rowNumberFromRef(cellRef);
  return `IF(AE${row}="","",IF(AND(AG${row}<=4,AE${row}<18),"WD 6am-6pm",IF(AND(AG${row}=5,AE${row}<18),"WD 6am-6pm",IF(AND(AG${row}<=4,OR(AE${row}=18,AE${row}=19)),"WD 6pm-8pm",IF(AND(AG${row}<=4,AE${row}>=20,AE${row}<=23),"WD 8pm-12am",IF(AND(AG${row}<=4,OR(AE${row}=0,AE${row}=1)),"WD 6am-6pm",IF(AND(OR(AG${row}=6,AG${row}=7),AE${row}>=2,AE${row}<=11),"WE 6am-12pm",IF(AND(OR(AG${row}=6,AG${row}=7),AE${row}>=12,AE${row}<=17),"WE 12pm-6pm",IF(AND(OR(AG${row}=5,AG${row}=6,AG${row}=7),OR(AE${row}=18,AE${row}=19)),"WE 6pm-8pm",IF(AND(AG${row}=5,AE${row}>=20,AE${row}<=23),"WE 8pm-2am",IF(AND(AG${row}=6,OR(AE${row}>=20,AE${row}<=1)),"WE 8pm-2am",IF(AND(AG${row}=7,AE${row}>=20,AE${row}<=23),"WE 8pm-2am",IF(AND(AG${row}=7,OR(AE${row}=0,AE${row}=1)),"WE 8pm-2am","")))))))))))))`;
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (!text) return null;
  const normalized = text
    .replace(/[$,%]/g, "")
    .replace(/\bSOL\b/gi, "")
    .replace(/,/g, "")
    .trim();
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  return null;
}

function parseDateSerial(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 20000 && value < 80000 ? value : null;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    return serial > 20000 && serial < 80000 ? serial : null;
  }
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return excelDateSerial(year, Number(slash[1]), Number(slash[2]));
  }
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return excelDateSerial(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  return null;
}

function excelDateSerial(year, month, day) {
  const ms = Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30);
  const serial = Math.round(ms / 86400000);
  return Number.isFinite(serial) && serial > 0 ? serial : null;
}

function ref(columnIndex, row) {
  let name = "";
  let n = columnIndex + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return `${name}${row}`;
}

function xml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function workbookXml(sheetName = "Master Trading Log") {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function workbookRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function appPropsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Snipalot</Application></Properties>`;
}

function corePropsXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Snipalot master trading log flow</dc:creator><cp:lastModifiedBy>Snipalot master trading log flow</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}
