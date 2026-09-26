import { describe, expect, it } from "@jest/globals";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { renderPdf, wrap } from "../src/services/render-pdf.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Roche — account brief",
  subtitle: "internal",
  audience: "internal",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "prose", heading: "Where Dell stands", body: "Dell holds storage-file.", cites: ["c1"] },
    { kind: "table", heading: "Incumbency", columns: ["segment", "vendor"], rows: [["storage-file", "dell"]] },
    { kind: "facts", heading: "Key facts", items: [{ label: "accounts", value: "12" }] },
  ],
  citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
};

describe("renderPdf", () => {
  it("produces a loadable PDF carrying the artifact title", async () => {
    const doc = await PDFDocument.load(await renderPdf(artifact));

    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe("Roche — account brief");
  });

  it("refuses an external artifact that carries internal content", async () => {
    const leaky: Artifact = { ...artifact, audience: "external" };

    await expect(renderPdf(leaky)).rejects.toThrow(/internal-only/i);
  });

  it("renders model-written text the standard font cannot encode instead of failing the export", async () => {
    // Helvetica only covers WinAnsi. Summaries and headlines carry arrows, math
    // signs, CJK and emoji; pdf-lib throws on those and the whole job failed.
    const unicode: Artifact = {
      ...artifact,
      title: "Novartis → cloud ≥ 2027 😀",
      sections: [{ kind: "prose", heading: "Spend ↑", body: "Azure ≥ AWS → 日本 rollout ≤ Q3 😀", cites: [] }],
      citations: [],
    };
    const buffer = await renderPdf(unicode);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const { text } = await parser.getText();
    await parser.destroy();

    expect(text).toContain("Azure >= AWS -> ?? rollout <= Q3 ?");
    expect(text).toContain("Novartis -> cloud >= 2027 ?");
    expect((await PDFDocument.load(buffer)).getTitle()).toBe("Novartis → cloud ≥ 2027 😀");
  });

  it("renders a table's column headers and a cell value into extractable text", async () => {
    const buffer = await renderPdf(artifact);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const { text } = await parser.getText();
    await parser.destroy();

    expect(text).toContain("segment");
    expect(text).toContain("vendor");
    expect(text).toContain("storage-file");
    expect(text).toContain("dell");
  });

  it("renders a facts section's labels and values into extractable text", async () => {
    const buffer = await renderPdf(artifact);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const { text } = await parser.getText();
    await parser.destroy();

    expect(text).toContain("accounts: 12");
  });

  it("renders a citation's title and url into the Sources block", async () => {
    const buffer = await renderPdf(artifact);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const { text } = await parser.getText();
    await parser.destroy();

    expect(text).toContain("Sources");
    expect(text).toContain("Blocks & Files");
    expect(text).toContain("https://example.test/a");
  });

  it("spills onto a second page when content is long enough, and the overflow is extractable", async () => {
    const longBody = Array.from({ length: 400 }, (_, i) => `filler-word-${i}`).join(" ");
    const overflow: Artifact = {
      title: "Long report",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections: [{ kind: "prose", heading: "Long section", body: longBody, cites: [] }],
      citations: [],
    };

    const buffer = await renderPdf(overflow);
    const loaded = await PDFDocument.load(buffer);
    expect(loaded.getPageCount()).toBeGreaterThan(1);

    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const { text } = await parser.getText();
    await parser.destroy();

    expect(text).toContain("filler-word-399");
  });

  it("renders a citation whose url is a single token longer than the line limit, still producing a document", async () => {
    const longUrl = `https://example.test/${"a".repeat(120)}`;
    const withLongCitation: Artifact = {
      ...artifact,
      citations: [{ id: "c1", title: "Some Title", url: longUrl }],
    };

    const buffer = await renderPdf(withLongCitation);
    const loaded = await PDFDocument.load(buffer);

    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("keeps a section heading on the same page as its first line of content (no orphaned heading)", async () => {
    const sections: Artifact["sections"] = Array.from({ length: 60 }, (_, i) => ({
      kind: "facts" as const,
      heading: `Section heading ${i}`,
      items: [{ label: `label-${i}`, value: `value-${i}` }],
    }));
    const manyPages: Artifact = {
      title: "Pagination stress",
      audience: "internal",
      generatedAt: "2026-09-22T10:00:00.000Z",
      sections,
      citations: [],
    };

    const buffer = await renderPdf(manyPages);
    const loaded = await PDFDocument.load(buffer);
    expect(loaded.getPageCount()).toBeGreaterThan(1);

    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    await parser.destroy();

    for (let i = 0; i < sections.length; i++) {
      const heading = `Section heading ${i}`;
      const contentLine = `label-${i}: value-${i}`;
      const page = result.pages.find((p) => p.text.includes(heading));

      expect(page).toBeDefined();
      expect(page?.text).toContain(contentLine);
    }
  });
});

describe("wrap", () => {
  it("returns an empty array for empty text", () => {
    expect(wrap("", 95)).toEqual([]);
  });

  it("hard-splits a word longer than max when it is the very first word, without a leading blank line", () => {
    const word = "a".repeat(50);

    const lines = wrap(word, 20);

    expect(lines).toEqual([word.slice(0, 20), word.slice(20, 40), word.slice(40, 50)]);
    expect(lines.some((l) => l.length === 0)).toBe(false);
  });

  it("flushes the current line before hard-splitting a later oversized word, with no blank line", () => {
    const word = "b".repeat(50);
    const text = `short ${word}`;

    const lines = wrap(text, 20);

    expect(lines[0]).toBe("short");
    expect(lines.slice(1)).toEqual([word.slice(0, 20), word.slice(20, 40), word.slice(40, 50)]);
    expect(lines.some((l) => l.length === 0)).toBe(false);
  });

  it("hard-splits a citation's oversized url token with no blank line before it", () => {
    const longUrl = `https://example.test/${"a".repeat(120)}`;
    const line = `[c1] Some Title — ${longUrl}`;

    const lines = wrap(line, 95);

    expect(lines.some((l) => l.length === 0)).toBe(false);
    expect(lines.every((l) => l.length <= 95)).toBe(true);
  });
});
