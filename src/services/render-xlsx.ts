// Artifact -> .xlsx. Knows nothing about vendors or accounts: it lays out
// sections, which is what makes any artifact expressible in this format.
import ExcelJS from "exceljs";
import { assertExternalSafe, type Artifact } from "./artifact.js";

// Excel rejects these in a sheet name, and silently truncates past 31 chars.
function sheetName(heading: string, used: Set<string>): string {
  const cleaned = heading.replace(/[*?:/\\[\]]/g, " ").slice(0, 31) || "Sheet";
  let name = cleaned;
  let n = 2;
  while (used.has(name)) name = `${cleaned.slice(0, 28)} ${n++}`;
  used.add(name);
  return name;
}

export async function renderXlsx(artifact: Artifact): Promise<Buffer> {
  assertExternalSafe(artifact);

  const book = new ExcelJS.Workbook();
  book.created = new Date(artifact.generatedAt);
  const used = new Set<string>();

  for (const section of artifact.sections) {
    const sheet = book.addWorksheet(sheetName(section.heading, used));
    switch (section.kind) {
      case "table":
        sheet.addRow(section.columns);
        for (const row of section.rows) sheet.addRow(row);
        sheet.getRow(1).font = { bold: true };
        break;
      case "facts":
        sheet.addRow(["label", "value"]);
        for (const item of section.items) sheet.addRow([item.label, item.value]);
        sheet.getRow(1).font = { bold: true };
        break;
      case "prose":
        sheet.addRow([section.body]);
        break;
      case "chart":
        // A chart is a picture; in a spreadsheet the data behind it is more
        // useful than the picture, and the gatherer emits both.
        sheet.addRow([`(chart: ${section.heading})`]);
        break;
    }
  }

  const sources = book.addWorksheet(sheetName("Sources", used));
  sources.addRow(["id", "title", "url"]);
  sources.getRow(1).font = { bold: true };
  for (const cite of artifact.citations) sources.addRow([cite.id, cite.title, cite.url]);

  return Buffer.from(await book.xlsx.writeBuffer());
}
