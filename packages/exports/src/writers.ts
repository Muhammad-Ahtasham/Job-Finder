import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import ExcelJS from 'exceljs';
import { csvLine, sanitizeCell, type Cell } from './sanitize';
import type { ExportColumn } from './rows';

/** Writes rows one at a time to a file; memory use does not grow with the export. */
export interface RowSink {
  write(cells: Cell[]): Promise<void>;
  close(): Promise<void>;
}

const BOM = '﻿'; // Excel opens UTF-8 CSV correctly only with a byte order mark

export async function openCsv(path: string, headers: string[]): Promise<RowSink> {
  const stream: WriteStream = createWriteStream(path, { encoding: 'utf8', mode: 0o600 });
  const failed = new Promise<never>((_, reject) => stream.once('error', reject));
  const put = async (text: string) => {
    if (!stream.write(text)) await Promise.race([once(stream, 'drain'), failed]);
  };
  await put(BOM + csvLine(headers));
  return {
    write: (cells) => put(csvLine(cells.map(sanitizeCell))),
    close: async () => {
      stream.end();
      await Promise.race([once(stream, 'finish'), failed]);
    },
  };
}

export async function openXlsx<T>(
  path: string,
  sheetName: string,
  columns: ExportColumn<T>[],
): Promise<RowSink> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true });
  workbook.creator = 'Job Intelligence';
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultColWidth: 16 },
  });
  sheet.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.commit();
  return {
    // Text goes in as text (never as a formula object) and is neutralised as well.
    write: async (cells) => {
      sheet.addRow(cells.map(sanitizeCell)).commit();
    },
    close: async () => {
      sheet.commit();
      await workbook.commit();
    },
  };
}
