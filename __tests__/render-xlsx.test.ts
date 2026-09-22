import { describe, expect, it } from "@jest/globals";
import { loadWorkbook } from "./helpers/load-workbook.js";
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
    const book = await loadWorkbook(await renderXlsx(artifact));

    expect(book.worksheets.map((w) => w.name)).toEqual(["By segment", "Summary", "Notes", "Sources"]);
  });

  // The gate that stops account intelligence reaching a customer. Excel is the
  // likeliest format for an incumbency matrix, so this renderer is the one most
  // exposed to the mistake.
  it("refuses an external artifact that carries internal content", async () => {
    const leaky: Artifact = {
      ...artifact,
      audience: "external",
      sections: [{ kind: "facts", heading: "Position", items: [{ label: "confidence", value: "high" }] }],
    };

    await expect(renderXlsx(leaky)).rejects.toThrow(/internal-only/i);
  });

  it("writes a table's columns as the header row and its rows beneath", async () => {
    const book = await loadWorkbook(await renderXlsx(artifact));
    const sheet = book.getWorksheet("By segment");

    expect(sheet?.getRow(1).values).toEqual([undefined, "segment", "roche"]);
    expect(sheet?.getRow(2).values).toEqual([undefined, "storage-file", "dell"]);
  });

  it("always writes a Sources sheet so a claim can be traced", async () => {
    const book = await loadWorkbook(await renderXlsx(artifact));
    const sheet = book.getWorksheet("Sources");

    expect(sheet?.getRow(2).values).toEqual([undefined, "c1", "Blocks & Files", "https://example.test/a"]);
  });

  it("replaces characters Excel forbids in a sheet name", async () => {
    const forbidden: Artifact = {
      title: "Forbidden characters",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections: [
        { kind: "facts", heading: "Q3: storage/backup", items: [{ label: "accounts", value: "3" }] },
      ],
      citations: [],
    };

    const book = await loadWorkbook(await renderXlsx(forbidden));

    for (const name of book.worksheets.map((w) => w.name)) {
      expect(name).not.toMatch(/[:/]/);
    }
  });

  it("truncates a heading longer than Excel's 31-character limit", async () => {
    const longHeading = "A".repeat(60);
    const long: Artifact = {
      title: "Long heading",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections: [{ kind: "facts", heading: longHeading, items: [{ label: "accounts", value: "3" }] }],
      citations: [],
    };

    const book = await loadWorkbook(await renderXlsx(long));

    for (const name of book.worksheets.map((w) => w.name)) {
      expect(name.length).toBeLessThanOrEqual(31);
    }
  });

  it("de-duplicates two sections that share a heading", async () => {
    const duplicate: Artifact = {
      title: "Duplicate headings",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections: [
        { kind: "facts", heading: "Summary", items: [{ label: "accounts", value: "3" }] },
        { kind: "facts", heading: "Summary", items: [{ label: "accounts", value: "5" }] },
      ],
      citations: [],
    };

    const book = await loadWorkbook(await renderXlsx(duplicate));

    const names = book.worksheets.map((w) => w.name).filter((name) => name.startsWith("Summary"));
    expect(names.length).toBe(2);
    expect(new Set(names).size).toBe(2);
  });

  it("does not collide with the Sources sheet", async () => {
    const clashing: Artifact = {
      title: "Sources clash",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections: [{ kind: "facts", heading: "Sources", items: [{ label: "accounts", value: "3" }] }],
      citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
    };

    const book = await loadWorkbook(await renderXlsx(clashing));

    const sourcesSheets = book.worksheets.filter((w) => w.name.startsWith("Sources"));
    expect(sourcesSheets.length).toBe(2);

    const citationsSheet = sourcesSheets.find((w) => w.getRow(2).values && (w.getRow(2).values as unknown[])[1] === "c1");
    expect(citationsSheet).toBeDefined();
    expect(citationsSheet?.getRow(2).values).toEqual([undefined, "c1", "Blocks & Files", "https://example.test/a"]);
  });
});
