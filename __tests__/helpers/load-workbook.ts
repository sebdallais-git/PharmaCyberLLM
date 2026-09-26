// Loads a rendered .xlsx buffer back into an ExcelJS workbook so tests can
// assert on parsed output rather than on the bytes we just wrote.
//
// The cast is unavoidable and belongs here rather than at every call site:
// exceljs/index.d.ts:1 declares its own global `interface Buffer extends
// ArrayBuffer {}`, which shadows Node's generic `Buffer<ArrayBufferLike>`, so
// `workbook.xlsx.load()` rejects a genuine Node Buffer. The value we pass is a
// real Buffer, which is what exceljs expects at runtime; only its typing is
// wrong. Removing this helper means seven copies of the same cast.

import ExcelJS from "exceljs";

type ExcelJsBuffer = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJsBuffer);
  return workbook;
}
