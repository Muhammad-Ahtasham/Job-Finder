/**
 * Spreadsheet formula injection: Excel, LibreOffice and Google Sheets run a cell as a formula when
 * its text starts with `=`, `+`, `-` or `@` (and a leading tab / carriage return can smuggle one
 * in). Company names, job titles and URLs come from the open internet, so every text cell is
 * neutralised by prefixing an apostrophe, which spreadsheets display as plain text.
 *
 * Numbers are real numbers and never touched, so a negative number stays one.
 */
// eslint-disable-next-line no-control-regex
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/;

export type Cell = string | number | boolean | null | undefined;

export function sanitizeCell(value: Cell): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return value;
  // Control characters have no place in a spreadsheet cell (tab/newline stay for readability).
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** One RFC 4180 CSV line from already-sanitised cells. */
export function csvLine(cells: (string | number | boolean)[]): string {
  return (
    cells
      .map((cell) => {
        const text = String(cell);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      })
      .join(',') + '\r\n'
  );
}
