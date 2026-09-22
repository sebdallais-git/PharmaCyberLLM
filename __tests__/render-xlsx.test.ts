import { describe, expect, it } from "@jest/globals";
import ExcelJS from "exceljs";
import { renderXlsx } from "../src/services/render-xlsx.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Incumbency matrix",
  audience: "internal",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "table", heading: "By segment", columns: ["segment", "roche"], rows: [["storage-file", "dell"]] },
    { kind: "facts", heading: "Summary", items: [{ label: "accounts", value: "3" }] },
    { kind: "prose", heading: "Notes", body: "Dell holds file at all three.", cites: [] },
  ],
  citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
};

describe("renderXlsx", () => {
  it("gives every section its own worksheet, named after the heading", async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await renderXlsx(artifact));

    expect(book.worksheets.map((w) => w.name)).toEqual(["By segment", "Summary", "Notes", "Sources"]);
  });

  it("writes a table's columns as the header row and its rows beneath", async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await renderXlsx(artifact));
    const sheet = book.getWorksheet("By segment");

    expect(sheet?.getRow(1).values).toEqual([undefined, "segment", "roche"]);
    expect(sheet?.getRow(2).values).toEqual([undefined, "storage-file", "dell"]);
  });

  it("always writes a Sources sheet so a claim can be traced", async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await renderXlsx(artifact));
    const sheet = book.getWorksheet("Sources");

    expect(sheet?.getRow(2).values).toEqual([undefined, "c1", "Blocks & Files", "https://example.test/a"]);
  });
});
