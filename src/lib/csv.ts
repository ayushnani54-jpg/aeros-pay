/**
 * CSV SERIALISATION, INCLUDING FORMULA-INJECTION DEFENCE (spec §44)
 * ===========================================================================
 *
 * Written here rather than pulled from a package on purpose: the escaping
 * rules below are a SECURITY CONTROL, and a security control the project can
 * read in forty lines is worth more than one it has to trust.
 *
 * There are two entirely separate problems, and conflating them is how CSV
 * exports go wrong.
 *
 * 1. CSV CORRECTNESS (RFC 4180). A field containing a comma, a double quote,
 *    a CR or an LF must be wrapped in double quotes, and every embedded double
 *    quote doubled. Get this wrong and a transaction reason containing a comma
 *    silently shifts every later column by one.
 *
 * 2. SPREADSHEET FORMULA INJECTION. This is NOT a CSV problem — a file can be
 *    perfectly valid CSV and still be an attack. Excel, LibreOffice and Google
 *    Sheets treat a cell whose text begins with `=`, `+`, `-` or `@` as a
 *    FORMULA, and both a leading TAB and a leading CR are stripped by the
 *    importer before that test is applied, so they are lead-ins to the same
 *    thing. A user who names their company `=cmd|'/c calc'!A1` is writing code
 *    into the Government's spreadsheet.
 *
 *    The defence is to make the cell unambiguously TEXT before the spreadsheet
 *    ever parses it, by prefixing a single quote — the character every one of
 *    those applications reads as "what follows is literal". The visible value
 *    is preserved, the formula never evaluates, and the change is confined to
 *    the CSV rendering: `exportsJson` emits the same row untouched, so the
 *    machine-readable export is lossless.
 *
 *    The guard applies to STRINGS ONLY. A numeric column holding -500 is
 *    serialised by `csvCell` from a number, takes the numeric branch, and
 *    comes out as `-500` — Aeros amounts are never mangled. It is text the
 *    user typed that gets neutralised, which is exactly the text that can be
 *    hostile.
 */

/** Characters that make a spreadsheet treat the rest of a cell as a formula,
 * plus the two whitespace lead-ins importers strip before deciding. */
const FORMULA_LEAD_INS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** The character every major spreadsheet reads as "treat this cell as text". */
export const CSV_TEXT_GUARD = "'";

/** True when a spreadsheet would treat this raw text as a formula. */
export function looksLikeFormula(value: string): boolean {
  return value.length > 0 && FORMULA_LEAD_INS.has(value[0]!);
}

/**
 * Neutralises a single user-controlled string for a spreadsheet cell.
 * Idempotent in effect: a value already starting with `'` is not a formula
 * lead-in, so it is returned unchanged.
 */
export function neutralizeFormula(value: string): string {
  return looksLikeFormula(value) ? `${CSV_TEXT_GUARD}${value}` : value;
}

/** True when RFC 4180 requires this rendered field to be quoted. */
function needsQuoting(value: string): boolean {
  if (value.length === 0) return false;
  if (/[",\r\n]/.test(value)) return true;
  // Leading/trailing whitespace is quoted so it survives a round trip rather
  // than being trimmed by a lenient reader.
  return value !== value.trim();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Renders one value as a CSV field.
 *
 * Type decides the treatment, which is the whole point:
 *   null / undefined  empty field (not the text "null")
 *   number / bigint   the number, never guarded — an amount is not text
 *   boolean           true / false
 *   Date              ISO-8601 UTC instant, unambiguous in every spreadsheet
 *   everything else   stringified, formula-guarded, then quoted if needed
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();

  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const guarded = neutralizeFormula(text);
  return needsQuoting(guarded) ? quote(guarded) : guarded;
}

/**
 * Renders one CSV record, terminated with CRLF (what RFC 4180 specifies and
 * what Excel is happiest with).
 */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/**
 * A header row.
 *
 * Column names are OURS, never user data, so they need no formula guard — but
 * they go through `csvCell` anyway rather than being concatenated by hand,
 * because one code path is easier to be sure about than two.
 */
export function csvHeader(columns: readonly string[]): string {
  return csvRow(columns);
}

/**
 * A UTF-8 byte-order mark.
 *
 * Excel on Windows still guesses the legacy code page for a BOM-less file,
 * which turns any non-ASCII name into mojibake. Three bytes at the front of
 * the stream is the entire fix; every other reader ignores them.
 */
export const UTF8_BOM = "﻿";

/**
 * Minimal RFC 4180 reader, used by the test suite to prove that everything
 * written above ROUND TRIPS — that a reason containing `a "quoted", multi
 * line` value comes back as exactly that string, and that the only difference
 * between what went in and what comes out is the deliberate text guard.
 *
 * It is exported because a serialiser whose escaping is only checked by eye is
 * not checked at all. It is not used by any production path.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // A BOM is metadata, not data.
  if (text.startsWith(UTF8_BOM)) i = 1;

  while (i < text.length) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
