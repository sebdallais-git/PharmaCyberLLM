# Artifact Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chatbot produces any artifact (account brief, incumbency matrix, vendor comparison) in any of three formats (xlsx, pdf, pptx), delivered by download, Telegram or an iCloud folder.

**Architecture:** A typed `Artifact` model sits between gathering and rendering. Gatherers know about vendors, accounts and segments and produce an `Artifact`; renderers know only `Section` kinds and produce bytes. A job queue runs the pipeline asynchronously because the LLM narration step takes minutes. Delivery is a strategy chosen per request.

**Tech Stack:** TypeScript (ESM, strict), Express, `exceljs`, `pdf-lib`, `pptxgenjs`, `better-sqlite3`, Jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-09-22-artifact-export-design.md`

## Global Constraints

- TypeScript strict; ES modules (`import`/`export`), never CommonJS. Relative imports end in `.js`.
- No `any` — use `unknown` with type guards. Prefer interfaces over type aliases.
- Filenames kebab-case; functions camelCase; comments in English.
- Run `npm run typecheck` after every code change. Tests: `npm test`.
- **No test may touch a live service.** Every unit takes injected dependencies, following `ReindexDeps` in `src/services/reindex.ts` and the harness in `__tests__/watchlist-ingest.test.ts`.
- `audience` has **no default**. A request without it is a 400.
- Charts render to **SVG, never PNG** — the PNG path needs `node-canvas` and native Cairo.
- Never edit `.env`.
- New routes register in `src/server.ts` beside the existing `app.use("/api/…", …)` block (lines 50-55).

---

### Task 1: The artifact model

**Files:**
- Create: `src/services/artifact.ts`
- Test: `__tests__/artifact.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Artifact`, `Section`, `Citation`, `Audience`, `isAudience(value: unknown): value is Audience`, `assertExternalSafe(artifact: Artifact): void`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { assertExternalSafe, isAudience, type Artifact } from "../src/services/artifact.js";

const base = (over: Partial<Artifact> = {}): Artifact => ({
  title: "Roche — account brief",
  audience: "external",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [],
  citations: [],
  ...over,
});

describe("isAudience", () => {
  it("accepts the two declared audiences", () => {
    expect(isAudience("internal")).toBe(true);
    expect(isAudience("external")).toBe(true);
  });

  it("rejects anything else, including undefined", () => {
    expect(isAudience(undefined)).toBe(false);
    expect(isAudience("customer")).toBe(false);
  });
});

describe("assertExternalSafe", () => {
  // The gatherer is supposed to omit these for an external artifact. This is
  // the backstop: a leak here reaches a customer.
  it("passes an external artifact with no internal fields", () => {
    expect(() => assertExternalSafe(base())).not.toThrow();
  });

  it("rejects an external artifact carrying an incumbency section", () => {
    const artifact = base({
      sections: [{ kind: "table", heading: "Incumbency", columns: ["segment"], rows: [["storage-file"]] }],
    });
    expect(() => assertExternalSafe(artifact)).toThrow(/incumbency/i);
  });

  it("rejects an external artifact carrying a confidence field", () => {
    const artifact = base({
      sections: [{ kind: "facts", heading: "Position", items: [{ label: "confidence", value: "high" }] }],
    });
    expect(() => assertExternalSafe(artifact)).toThrow(/confidence/i);
  });

  it("ignores internal artifacts entirely", () => {
    const artifact = base({
      audience: "internal",
      sections: [{ kind: "facts", heading: "Position", items: [{ label: "confidence", value: "high" }] }],
    });
    expect(() => assertExternalSafe(artifact)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="artifact.test"`
Expected: FAIL — "Cannot find module '../src/services/artifact.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// The join between gathering and rendering. Gatherers know about vendors and
// accounts; renderers know only these shapes. That is what lets any artifact be
// expressed in any format.

export const AUDIENCES = ["internal", "external"] as const;
export type Audience = (typeof AUDIENCES)[number];

export function isAudience(value: unknown): value is Audience {
  return typeof value === "string" && (AUDIENCES as readonly string[]).includes(value);
}

export interface Citation {
  id: string;
  title: string;
  url: string;
}

export type Section =
  | { kind: "prose"; heading: string; body: string; cites: string[] }
  | { kind: "table"; heading: string; columns: string[]; rows: string[][] }
  | { kind: "facts"; heading: string; items: { label: string; value: string }[] }
  | { kind: "chart"; heading: string; spec: Record<string, unknown> };

export interface Artifact {
  title: string;
  subtitle?: string;
  audience: Audience;
  generatedAt: string;
  sections: Section[];
  citations: Citation[];
}

// Words that must never appear in an external artifact's structure. The
// gatherer omits these sections rather than redacting them, so this is a
// backstop against a gatherer bug, not the primary control.
const INTERNAL_ONLY = ["incumben", "confidence", "displace", "defend", "greenfield"];

export function assertExternalSafe(artifact: Artifact): void {
  if (artifact.audience !== "external") return;

  const haystack: string[] = [];
  for (const section of artifact.sections) {
    haystack.push(section.heading);
    if (section.kind === "table") haystack.push(...section.columns, ...section.rows.flat());
    if (section.kind === "facts") haystack.push(...section.items.map((i) => `${i.label} ${i.value}`));
  }

  for (const term of INTERNAL_ONLY) {
    const hit = haystack.find((text) => text.toLowerCase().includes(term));
    if (hit !== undefined) {
      throw new Error(`external artifact contains internal-only content ("${term}" in "${hit}")`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPatterns="artifact.test"` — Expected: PASS (8 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/services/artifact.ts __tests__/artifact.test.ts
git commit -m "feat: typed artifact model with an external-safety backstop"
```

---

### Task 2: Excel renderer

**Files:**
- Create: `src/services/render-xlsx.ts`
- Test: `__tests__/render-xlsx.test.ts`
- Modify: `package.json` (add `exceljs`)

**Interfaces:**
- Consumes: `Artifact`, `Section` from Task 1
- Produces: `renderXlsx(artifact: Artifact): Promise<Buffer>`

- [ ] **Step 1: Install the library**

```bash
npm install exceljs
```

- [ ] **Step 2: Write the failing test**

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="render-xlsx"`
Expected: FAIL — "Cannot find module '../src/services/render-xlsx.js'"

- [ ] **Step 4: Write minimal implementation**

```typescript
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
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --testPathPatterns="render-xlsx"` — Expected: PASS (3 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/services/render-xlsx.ts __tests__/render-xlsx.test.ts package.json package-lock.json
git commit -m "feat: render an artifact to xlsx"
```

---

### Task 3: PDF renderer

**Files:**
- Create: `src/services/render-pdf.ts`
- Test: `__tests__/render-pdf.test.ts`
- Modify: `package.json` (add `pdf-lib`)

**Interfaces:**
- Consumes: `Artifact` from Task 1
- Produces: `renderPdf(artifact: Artifact): Promise<Buffer>`

- [ ] **Step 1: Install the library**

```bash
npm install pdf-lib
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { PDFDocument } from "pdf-lib";
import { renderPdf } from "../src/services/render-pdf.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Roche — account brief",
  subtitle: "internal",
  audience: "internal",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "prose", heading: "Where Dell stands", body: "Dell holds storage-file.", cites: ["c1"] },
    { kind: "table", heading: "Incumbency", columns: ["segment", "vendor"], rows: [["storage-file", "dell"]] },
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="render-pdf"`
Expected: FAIL — "Cannot find module '../src/services/render-pdf.js'"

- [ ] **Step 4: Write minimal implementation**

```typescript
// Artifact -> .pdf. Deliberately plain: a one-pager whose value is the facts,
// not the typography. Text is wrapped by hand because pdf-lib draws strings at
// coordinates and does no layout of its own.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { assertExternalSafe, type Artifact } from "./artifact.js";

const MARGIN = 50;
const BODY = 11;
const HEADING = 14;

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > max) {
      out.push(line.trim());
      line = word;
    } else {
      line += ` ${word}`;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

export async function renderPdf(artifact: Artifact): Promise<Buffer> {
  assertExternalSafe(artifact);

  const doc = await PDFDocument.create();
  doc.setTitle(artifact.title);
  doc.setCreationDate(new Date(artifact.generatedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage();
  let y = page.getHeight() - MARGIN;

  const write = (text: string, size: number, useBold = false) => {
    for (const line of wrap(text, size === HEADING ? 70 : 95)) {
      if (y < MARGIN) {
        page = doc.addPage();
        y = page.getHeight() - MARGIN;
      }
      page.drawText(line, { x: MARGIN, y, size, font: useBold ? bold : font, color: rgb(0, 0, 0) });
      y -= size + 4;
    }
  };

  write(artifact.title, HEADING + 4, true);
  if (artifact.subtitle) write(artifact.subtitle, BODY);
  y -= 10;

  for (const section of artifact.sections) {
    write(section.heading, HEADING, true);
    switch (section.kind) {
      case "prose":
        write(section.body, BODY);
        break;
      case "table":
        write(section.columns.join("  |  "), BODY, true);
        for (const row of section.rows) write(row.join("  |  "), BODY);
        break;
      case "facts":
        for (const item of section.items) write(`${item.label}: ${item.value}`, BODY);
        break;
      case "chart":
        write(`(chart: ${section.heading})`, BODY);
        break;
    }
    y -= 8;
  }

  if (artifact.citations.length > 0) {
    write("Sources", HEADING, true);
    for (const cite of artifact.citations) write(`[${cite.id}] ${cite.title} — ${cite.url}`, BODY);
  }

  return Buffer.from(await doc.save());
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --testPathPatterns="render-pdf"` — Expected: PASS (2 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/services/render-pdf.ts __tests__/render-pdf.test.ts package.json package-lock.json
git commit -m "feat: render an artifact to pdf"
```

---

### Task 4: PowerPoint renderer

**Files:**
- Create: `src/services/render-pptx.ts`
- Test: `__tests__/render-pptx.test.ts`
- Modify: `package.json` (add `pptxgenjs`)

**Interfaces:**
- Consumes: `Artifact` from Task 1
- Produces: `renderPptx(artifact: Artifact): Promise<Buffer>`

- [ ] **Step 1: Install the library**

```bash
npm install pptxgenjs
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { buildPptx, renderPptx } from "../src/services/render-pptx.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Roche — AI infrastructure",
  audience: "external",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "prose", heading: "Why now", body: "Roche is scaling its AI factory.", cites: ["c1"] },
    { kind: "table", heading: "Portfolio", columns: ["product", "use"], rows: [["PowerScale", "cryo-EM"]] },
  ],
  citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
};

describe("renderPptx", () => {
  // A .pptx is a zip; its first bytes are the zip magic number. Asserting that
  // proves a real file was produced without unzipping it in a unit test.
  it("produces a pptx file", async () => {
    const buffer = await renderPptx(artifact);

    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 2).toString("binary")).toBe("PK");
  });

  it("produces a title slide plus one slide per section plus sources", async () => {
    // buildPptx returns the count so a test can assert layout without unzipping.
    const { slideCount } = await buildPptx(artifact);

    expect(slideCount).toBe(4);
  });

  it("refuses an external artifact that carries internal content", async () => {
    const leaky: Artifact = {
      ...artifact,
      sections: [{ kind: "facts", heading: "Position", items: [{ label: "confidence", value: "high" }] }],
    };

    await expect(renderPptx(leaky)).rejects.toThrow(/internal-only/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="render-pptx"`
Expected: FAIL — "Cannot find module '../src/services/render-pptx.js'"

- [ ] **Step 4: Write minimal implementation**

```typescript
// Artifact -> .pptx. One slide per section, plus a title slide and a sources
// slide. pptxgenjs writes a real Office file with no Office installed.
import PptxGenJS from "pptxgenjs";
import { assertExternalSafe, type Artifact } from "./artifact.js";

export async function buildPptx(artifact: Artifact): Promise<{ buffer: Buffer; slideCount: number }> {
  assertExternalSafe(artifact);

  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_16x9";
  let slideCount = 0;

  const title = deck.addSlide();
  slideCount++;
  title.addText(artifact.title, { x: 0.5, y: 2.2, w: 9, h: 1, fontSize: 32, bold: true });
  if (artifact.subtitle) title.addText(artifact.subtitle, { x: 0.5, y: 3.2, w: 9, h: 0.6, fontSize: 16 });

  for (const section of artifact.sections) {
    const slide = deck.addSlide();
    slideCount++;
    slide.addText(section.heading, { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true });

    switch (section.kind) {
      case "prose":
        slide.addText(section.body, { x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 14 });
        break;
      case "table":
        slide.addTable([section.columns, ...section.rows], { x: 0.5, y: 1.4, w: 9, fontSize: 12 });
        break;
      case "facts":
        slide.addText(section.items.map((i) => `${i.label}: ${i.value}`).join("\n"), {
          x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 14,
        });
        break;
      case "chart":
        // SVG, never PNG: the PNG path needs node-canvas and native Cairo.
        slide.addText(`(chart: ${section.heading})`, { x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 14 });
        break;
    }
  }

  if (artifact.citations.length > 0) {
    const sources = deck.addSlide();
    slideCount++;
    sources.addText("Sources", { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true });
    sources.addText(artifact.citations.map((c) => `[${c.id}] ${c.title} — ${c.url}`).join("\n"), {
      x: 0.5, y: 1.4, w: 9, h: 4, fontSize: 11,
    });
  }

  const buffer = (await deck.write({ outputType: "nodebuffer" })) as Buffer;
  return { buffer, slideCount };
}

export async function renderPptx(artifact: Artifact): Promise<Buffer> {
  return (await buildPptx(artifact)).buffer;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --testPathPatterns="render-pptx"` — Expected: PASS (3 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/services/render-pptx.ts __tests__/render-pptx.test.ts package.json package-lock.json
git commit -m "feat: render an artifact to pptx"
```

---

### Task 5: Delivery adapters

**Files:**
- Create: `src/services/export-delivery.ts`
- Test: `__tests__/export-delivery.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `DESTINATIONS`, `Destination`, `isDestination(value: unknown): value is Destination`, `DeliveryDeps`, `deliver(file: RenderedFile, destination: Destination, deps: DeliveryDeps): Promise<string>` where `RenderedFile = { filename: string; bytes: Buffer }`. The returned string is a human-readable location (a URL, "telegram", or an absolute path).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { deliver, isDestination, type DeliveryDeps } from "../src/services/export-delivery.js";

const file = { filename: "roche-brief.pdf", bytes: Buffer.from("hello") };

function fakeDeps(): DeliveryDeps & { written: Array<{ path: string; bytes: Buffer }>; sent: string[] } {
  const written: Array<{ path: string; bytes: Buffer }> = [];
  const sent: string[] = [];
  return {
    written,
    sent,
    downloadDir: "/tmp/exports",
    icloudDir: "/tmp/icloud/PharmaITChat_Artifacts",
    async writeFile(path, bytes) {
      written.push({ path, bytes });
    },
    async sendDocument(filename) {
      sent.push(filename);
    },
  };
}

describe("isDestination", () => {
  it("accepts the three declared destinations and rejects others", () => {
    expect(isDestination("download")).toBe(true);
    expect(isDestination("telegram")).toBe(true);
    expect(isDestination("icloud")).toBe(true);
    expect(isDestination("email")).toBe(false);
  });
});

describe("deliver", () => {
  it("writes into the download directory and returns a url", async () => {
    const deps = fakeDeps();

    const where = await deliver(file, "download", deps);

    expect(deps.written[0].path).toBe("/tmp/exports/roche-brief.pdf");
    expect(where).toContain("/api/export/file/roche-brief.pdf");
  });

  it("writes into the iCloud artifacts folder", async () => {
    const deps = fakeDeps();

    const where = await deliver(file, "icloud", deps);

    expect(deps.written[0].path).toBe("/tmp/icloud/PharmaITChat_Artifacts/roche-brief.pdf");
    expect(where).toBe("/tmp/icloud/PharmaITChat_Artifacts/roche-brief.pdf");
  });

  it("sends the document through telegram", async () => {
    const deps = fakeDeps();

    const where = await deliver(file, "telegram", deps);

    expect(deps.sent).toEqual(["roche-brief.pdf"]);
    expect(where).toBe("telegram");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-delivery"`
Expected: FAIL — "Cannot find module '../src/services/export-delivery.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// Where a rendered file goes. Three strategies behind one call, so the pipeline
// does not branch on destination.
import { join } from "node:path";

export const DESTINATIONS = ["download", "telegram", "icloud"] as const;
export type Destination = (typeof DESTINATIONS)[number];

export function isDestination(value: unknown): value is Destination {
  return typeof value === "string" && (DESTINATIONS as readonly string[]).includes(value);
}

export interface RenderedFile {
  filename: string;
  bytes: Buffer;
}

export interface DeliveryDeps {
  downloadDir: string;
  // ~/Documents is the iCloud-synced folder on this Mac, so anything written
  // here leaves the machine.
  icloudDir: string;
  writeFile(path: string, bytes: Buffer): Promise<void>;
  sendDocument(filename: string, bytes: Buffer): Promise<void>;
}

/** Returns a human-readable location: a URL, "telegram", or an absolute path. */
export async function deliver(
  file: RenderedFile,
  destination: Destination,
  deps: DeliveryDeps,
): Promise<string> {
  switch (destination) {
    case "download": {
      await deps.writeFile(join(deps.downloadDir, file.filename), file.bytes);
      return `/api/export/file/${file.filename}`;
    }
    case "icloud": {
      const path = join(deps.icloudDir, file.filename);
      await deps.writeFile(path, file.bytes);
      return path;
    }
    case "telegram": {
      await deps.sendDocument(file.filename, file.bytes);
      return "telegram";
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --testPathPatterns="export-delivery"` — Expected: PASS (4 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/services/export-delivery.ts __tests__/export-delivery.test.ts
git commit -m "feat: download, telegram and icloud delivery adapters"
```

---

### Task 6: Artifact gatherers

**Files:**
- Create: `src/services/export-artifacts.ts`
- Test: `__tests__/export-artifacts.test.ts`

**Interfaces:**
- Consumes: `Artifact`, `Audience` from Task 1
- Produces: `ARTIFACT_KINDS`, `ArtifactKind`, `isArtifactKind(value: unknown): value is ArtifactKind`, `GatherDeps`, `gather(kind: ArtifactKind, audience: Audience, options: { account?: string; vendor?: string }, deps: GatherDeps): Promise<Artifact>`

`GatherDeps` is `{ incumbency(): Promise<Array<{ account: string; segment: string; vendors: string[] }>>; positions(vendor: string): Promise<Array<{ segment: string; position: string; confidence: string; rationale: string }>>; news(entity: string, limit: number): Promise<Array<{ title: string; url: string; publishedAt: string }>> }`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { gather, isArtifactKind, type GatherDeps } from "../src/services/export-artifacts.js";

const deps: GatherDeps = {
  async incumbency() {
    return [
      { account: "roche", segment: "storage-file", vendors: ["dell"] },
      { account: "roche", segment: "storage-block", vendors: ["everpure"] },
    ];
  },
  async positions() {
    return [{ segment: "storage-file", position: "strong", confidence: "medium", rationale: "Contested." }];
  },
  async news() {
    return [{ title: "Roche builds AI factory", url: "https://example.test/a", publishedAt: "2026-09-20" }];
  },
};

describe("isArtifactKind", () => {
  it("accepts declared kinds and rejects others", () => {
    expect(isArtifactKind("account-brief")).toBe(true);
    expect(isArtifactKind("incumbency-matrix")).toBe(true);
    expect(isArtifactKind("sales-forecast")).toBe(false);
  });
});

describe("gather", () => {
  it("includes incumbency for an internal account brief", async () => {
    const artifact = await gather("account-brief", "internal", { account: "roche", vendor: "dell" }, deps);

    const headings = artifact.sections.map((s) => s.heading);
    expect(headings).toContain("Incumbency by segment");
  });

  // The external filter is applied HERE, not at render time: the internal
  // content is never in the object a renderer sees.
  it("omits incumbency and confidence from an external account brief", async () => {
    const artifact = await gather("account-brief", "external", { account: "roche", vendor: "dell" }, deps);

    const text = JSON.stringify(artifact).toLowerCase();
    expect(text).not.toContain("incumben");
    expect(text).not.toContain("confidence");
  });

  it("turns news into citations so a claim can be traced", async () => {
    const artifact = await gather("account-brief", "external", { account: "roche", vendor: "dell" }, deps);

    expect(artifact.citations).toEqual([
      { id: "c1", title: "Roche builds AI factory", url: "https://example.test/a" },
    ]);
  });

  it("builds a matrix of accounts against segments", async () => {
    const artifact = await gather("incumbency-matrix", "internal", {}, deps);
    const table = artifact.sections.find((s) => s.kind === "table");

    expect(table).toBeDefined();
    if (table?.kind === "table") {
      expect(table.columns).toEqual(["segment", "roche"]);
      expect(table.rows).toContainEqual(["storage-file", "dell"]);
    }
  });

  it("refuses an incumbency matrix for an external audience", async () => {
    // The whole artifact is internal by nature; there is no external version.
    await expect(gather("incumbency-matrix", "external", {}, deps)).rejects.toThrow(/internal/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-artifacts"`
Expected: FAIL — "Cannot find module '../src/services/export-artifacts.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// Gatherers turn the system's data into an Artifact. This is the only layer
// that knows about vendors, accounts and segments.
//
// The audience filter lives here rather than at render time: an external
// artifact never contains incumbency or confidence, so no formatting bug can
// leak it.
import type { Artifact, Audience, Citation, Section } from "./artifact.js";

export const ARTIFACT_KINDS = ["account-brief", "incumbency-matrix", "vendor-comparison"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export interface GatherDeps {
  incumbency(): Promise<Array<{ account: string; segment: string; vendors: string[] }>>;
  positions(vendor: string): Promise<Array<{ segment: string; position: string; confidence: string; rationale: string }>>;
  news(entity: string, limit: number): Promise<Array<{ title: string; url: string; publishedAt: string }>>;
}

function citationsFrom(items: Array<{ title: string; url: string }>): Citation[] {
  return items.map((item, i) => ({ id: `c${i + 1}`, title: item.title, url: item.url }));
}

export async function gather(
  kind: ArtifactKind,
  audience: Audience,
  options: { account?: string; vendor?: string },
  deps: GatherDeps,
): Promise<Artifact> {
  const generatedAt = new Date().toISOString();

  if (kind === "incumbency-matrix") {
    if (audience === "external") {
      throw new Error("incumbency-matrix is internal by nature; there is no external version");
    }
    const rows = await deps.incumbency();
    const accounts = [...new Set(rows.map((r) => r.account))].sort();
    const segments = [...new Set(rows.map((r) => r.segment))].sort();
    const table: Section = {
      kind: "table",
      heading: "Incumbency by segment",
      columns: ["segment", ...accounts],
      rows: segments.map((segment) => [
        segment,
        ...accounts.map((account) =>
          rows.find((r) => r.account === account && r.segment === segment)?.vendors.join("+") ?? "",
        ),
      ]),
    };
    return { title: "Incumbency matrix", audience, generatedAt, sections: [table], citations: [] };
  }

  const account = options.account ?? "";
  const vendor = options.vendor ?? "dell";
  const news = await deps.news(account || vendor, 10);
  const citations = citationsFrom(news);
  const sections: Section[] = [];

  if (audience === "internal") {
    const rows = (await deps.incumbency()).filter((r) => r.account === account);
    sections.push({
      kind: "table",
      heading: "Incumbency by segment",
      columns: ["segment", "installed"],
      rows: rows.map((r) => [r.segment, r.vendors.join("+")]),
    });

    const positions = await deps.positions(vendor);
    sections.push({
      kind: "table",
      heading: "Competitive position",
      columns: ["segment", "position", "confidence", "rationale"],
      rows: positions.map((p) => [p.segment, p.position, p.confidence, p.rationale]),
    });
  }

  sections.push({
    kind: "table",
    heading: "Recent developments",
    columns: ["date", "headline"],
    rows: news.map((n) => [n.publishedAt, n.title]),
  });

  const title = kind === "vendor-comparison" ? `${vendor} — competitive view` : `${account || vendor} — brief`;
  return { title, audience, generatedAt, sections, citations };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --testPathPatterns="export-artifacts"` — Expected: PASS (6 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/services/export-artifacts.ts __tests__/export-artifacts.test.ts
git commit -m "feat: artifact gatherers with audience filtering at source"
```

---

### Task 7: Job store

**Files:**
- Create: `src/services/export-jobs.ts`
- Test: `__tests__/export-jobs.test.ts`

**Interfaces:**
- Consumes: `ArtifactKind` (Task 6), `Destination` (Task 5), `Audience` (Task 1)
- Produces: `openExportJobs(path?: string): ExportJobStore` with `create(req): string`, `get(id): ExportJob | null`, `setStage(id, stage): void`, `complete(id, location): void`, `fail(id, stage, message): void`, `close(): void`. `ExportJob = { id, kind, format, audience, destination, stage, location, error, createdAt }` and `stage` is one of `queued | gathering | narrating | rendering | delivering | done | failed`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { openExportJobs } from "../src/services/export-jobs.js";

const request = {
  kind: "account-brief" as const,
  format: "pdf" as const,
  audience: "internal" as const,
  destination: "download" as const,
};

describe("export jobs", () => {
  it("creates a queued job and reads it back", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    expect(jobs.get(id)?.stage).toBe("queued");
    jobs.close();
  });

  // Stages are recorded so a failure says WHICH step failed -- the LLM step
  // takes minutes, and "it failed" is not actionable.
  it("records the stage a job reached", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    jobs.setStage(id, "narrating");

    expect(jobs.get(id)?.stage).toBe("narrating");
    jobs.close();
  });

  it("stores the location on completion", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    jobs.complete(id, "/api/export/file/roche-brief.pdf");

    const job = jobs.get(id);
    expect(job?.stage).toBe("done");
    expect(job?.location).toBe("/api/export/file/roche-brief.pdf");
    jobs.close();
  });

  it("records which stage failed and why", () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create(request);

    jobs.fail(id, "narrating", "model unreachable");

    const job = jobs.get(id);
    expect(job?.stage).toBe("failed");
    expect(job?.error).toBe("narrating: model unreachable");
    jobs.close();
  });

  it("returns null for an unknown id rather than throwing", () => {
    const jobs = openExportJobs(":memory:");

    expect(jobs.get("nope")).toBeNull();
    jobs.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-jobs"`
Expected: FAIL — "Cannot find module '../src/services/export-jobs.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// Export jobs. Follows the sqlite pattern in watchlist-store.ts: WAL, CREATE
// TABLE IF NOT EXISTS, a store object returned from an open function.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Audience } from "./artifact.js";
import type { ArtifactKind } from "./export-artifacts.js";
import type { Destination } from "./export-delivery.js";

export type ExportFormat = "xlsx" | "pdf" | "pptx";
export type Stage = "queued" | "gathering" | "narrating" | "rendering" | "delivering" | "done" | "failed";

export interface ExportRequest {
  kind: ArtifactKind;
  format: ExportFormat;
  audience: Audience;
  destination: Destination;
  account?: string;
  vendor?: string;
}

export interface ExportJob extends ExportRequest {
  id: string;
  stage: Stage;
  location: string | null;
  error: string | null;
  createdAt: string;
}

export interface ExportJobStore {
  create(request: ExportRequest): string;
  get(id: string): ExportJob | null;
  setStage(id: string, stage: Stage): void;
  complete(id: string, location: string): void;
  fail(id: string, stage: Stage, message: string): void;
  close(): void;
}

export function openExportJobs(path: string = join(process.cwd(), "data", "export-jobs.db")): ExportJobStore {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS export_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      format TEXT NOT NULL,
      audience TEXT NOT NULL,
      destination TEXT NOT NULL,
      account TEXT,
      vendor TEXT,
      stage TEXT NOT NULL,
      location TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const insert = db.prepare(`
    INSERT INTO export_jobs (id, kind, format, audience, destination, account, vendor, stage, created_at)
    VALUES (@id, @kind, @format, @audience, @destination, @account, @vendor, 'queued', @createdAt)
  `);
  const select = db.prepare(`SELECT * FROM export_jobs WHERE id = ?`);

  interface Row {
    id: string; kind: string; format: string; audience: string; destination: string;
    account: string | null; vendor: string | null; stage: string;
    location: string | null; error: string | null; created_at: string;
  }

  return {
    create(request) {
      const id = randomUUID();
      insert.run({
        id,
        kind: request.kind,
        format: request.format,
        audience: request.audience,
        destination: request.destination,
        account: request.account ?? null,
        vendor: request.vendor ?? null,
        createdAt: new Date().toISOString(),
      });
      return id;
    },
    get(id) {
      const row = select.get(id) as Row | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        kind: row.kind as ArtifactKind,
        format: row.format as ExportFormat,
        audience: row.audience as Audience,
        destination: row.destination as Destination,
        account: row.account ?? undefined,
        vendor: row.vendor ?? undefined,
        stage: row.stage as Stage,
        location: row.location,
        error: row.error,
        createdAt: row.created_at,
      };
    },
    setStage(id, stage) {
      db.prepare(`UPDATE export_jobs SET stage = ? WHERE id = ?`).run(stage, id);
    },
    complete(id, location) {
      db.prepare(`UPDATE export_jobs SET stage = 'done', location = ? WHERE id = ?`).run(location, id);
    },
    fail(id, stage, message) {
      db.prepare(`UPDATE export_jobs SET stage = 'failed', error = ? WHERE id = ?`).run(`${stage}: ${message}`, id);
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --testPathPatterns="export-jobs"` — Expected: PASS (5 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/services/export-jobs.ts __tests__/export-jobs.test.ts
git commit -m "feat: export job store with per-stage status"
```

---

### Task 8: The pipeline

**Files:**
- Create: `src/services/export-pipeline.ts`
- Test: `__tests__/export-pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 5, 6, 7
- Produces: `PipelineDeps`, `runExport(id: string, deps: PipelineDeps): Promise<void>`

`PipelineDeps` is `{ jobs: ExportJobStore; gather: typeof gather; gatherDeps: GatherDeps; narrate(artifact: Artifact): Promise<Artifact>; render: Record<ExportFormat, (a: Artifact) => Promise<Buffer>>; deliver: typeof deliver; deliveryDeps: DeliveryDeps }`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { runExport, type PipelineDeps } from "../src/services/export-pipeline.js";
import { openExportJobs } from "../src/services/export-jobs.js";
import type { Artifact } from "../src/services/artifact.js";

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  const artifact: Artifact = {
    title: "t", audience: "internal", generatedAt: "2026-09-22T10:00:00.000Z", sections: [], citations: [],
  };
  return {
    jobs: openExportJobs(":memory:"),
    async gather() {
      return artifact;
    },
    gatherDeps: {
      async incumbency() { return []; },
      async positions() { return []; },
      async news() { return []; },
    },
    async narrate(a) {
      return a;
    },
    render: {
      xlsx: async () => Buffer.from("x"),
      pdf: async () => Buffer.from("p"),
      pptx: async () => Buffer.from("k"),
    },
    async deliver() {
      return "/api/export/file/t.pdf";
    },
    deliveryDeps: {
      downloadDir: "/tmp/d",
      icloudDir: "/tmp/i",
      async writeFile() {},
      async sendDocument() {},
    },
    ...over,
  };
}

const request = {
  kind: "account-brief" as const,
  format: "pdf" as const,
  audience: "internal" as const,
  destination: "download" as const,
};

describe("runExport", () => {
  it("walks the job to done and records where the file went", async () => {
    const d = deps();
    const id = d.jobs.create(request);

    await runExport(id, d);

    const job = d.jobs.get(id);
    expect(job?.stage).toBe("done");
    expect(job?.location).toBe("/api/export/file/t.pdf");
    d.jobs.close();
  });

  // The LLM step takes minutes and is the one most likely to fail; the job must
  // say WHICH stage broke, not merely that it broke.
  it("records the failing stage when narration fails", async () => {
    const d = deps({
      async narrate() {
        throw new Error("model unreachable");
      },
    });
    const id = d.jobs.create(request);

    await runExport(id, d);

    expect(d.jobs.get(id)?.error).toBe("narrating: model unreachable");
    d.jobs.close();
  });

  it("does nothing for an unknown job id", async () => {
    const d = deps();

    await expect(runExport("nope", d)).resolves.toBeUndefined();
    d.jobs.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-pipeline"`
Expected: FAIL — "Cannot find module '../src/services/export-pipeline.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// gather -> narrate -> render -> deliver, with the job's stage recorded before
// each step. The stage is what makes a failure actionable: narration takes
// minutes and is the step most likely to break.
import type { Artifact } from "./artifact.js";
import type { GatherDeps, gather as gatherFn } from "./export-artifacts.js";
import type { DeliveryDeps, deliver as deliverFn } from "./export-delivery.js";
import type { ExportFormat, ExportJobStore, Stage } from "./export-jobs.js";

export interface PipelineDeps {
  jobs: ExportJobStore;
  gather: typeof gatherFn;
  gatherDeps: GatherDeps;
  narrate(artifact: Artifact): Promise<Artifact>;
  render: Record<ExportFormat, (artifact: Artifact) => Promise<Buffer>>;
  deliver: typeof deliverFn;
  deliveryDeps: DeliveryDeps;
}

export async function runExport(id: string, deps: PipelineDeps): Promise<void> {
  const job = deps.jobs.get(id);
  if (job === null) return;

  let stage: Stage = "gathering";
  try {
    deps.jobs.setStage(id, stage);
    const facts = await deps.gather(job.kind, job.audience, { account: job.account, vendor: job.vendor }, deps.gatherDeps);

    stage = "narrating";
    deps.jobs.setStage(id, stage);
    const artifact = await deps.narrate(facts);

    stage = "rendering";
    deps.jobs.setStage(id, stage);
    const bytes = await deps.render[job.format](artifact);

    stage = "delivering";
    deps.jobs.setStage(id, stage);
    const filename = `${artifact.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${job.format}`;
    const location = await deps.deliver({ filename, bytes }, job.destination, deps.deliveryDeps);

    deps.jobs.complete(id, location);
  } catch (err) {
    deps.jobs.fail(id, stage, err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --testPathPatterns="export-pipeline"` — Expected: PASS (3 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/services/export-pipeline.ts __tests__/export-pipeline.test.ts
git commit -m "feat: export pipeline with per-stage failure reporting"
```

---

### Task 9: API route

**Files:**
- Create: `src/api/export.ts`
- Modify: `src/server.ts` (add `app.use("/api/export", exportRouter);` beside the block at lines 50-55, and the matching import beside the other router imports)
- Modify: `src/api/auth.ts` (add `["POST", "/api/export"]` and `["GET", "/api/export"]` to the protected list, following the existing `/api/chat` entries at lines 9-11)
- Test: `__tests__/export-route.test.ts`

**Interfaces:**
- Consumes: `isAudience` (Task 1), `isArtifactKind` (Task 6), `isDestination` (Task 5), `openExportJobs` (Task 7), `runExport` (Task 8)
- Produces: `validateExportRequest(body: unknown): { ok: true; value: ExportRequest } | { ok: false; error: string }`, and the Express router as the default export

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { validateExportRequest } from "../src/api/export.js";

const good = {
  kind: "account-brief",
  format: "pdf",
  audience: "internal",
  destination: "telegram",
  account: "roche",
};

describe("validateExportRequest", () => {
  it("accepts a complete request", () => {
    const result = validateExportRequest(good);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destination).toBe("telegram");
  });

  it("defaults the destination to download", () => {
    const { destination: _drop, ...noDestination } = good;
    const result = validateExportRequest(noDestination);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destination).toBe("download");
  });

  // No default: an export that does not say who it is for must not guess,
  // because the two audiences contain different data.
  it("rejects a request with no audience", () => {
    const { audience: _drop, ...noAudience } = good;
    const result = validateExportRequest(noAudience);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/audience/i);
  });

  it("rejects an unknown format", () => {
    const result = validateExportRequest({ ...good, format: "keynote" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/format/i);
  });

  it("rejects an unknown artifact kind", () => {
    const result = validateExportRequest({ ...good, kind: "sales-forecast" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/kind/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-route"`
Expected: FAIL — "Cannot find module '../src/api/export.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// POST /api/export        -> { jobId }         (returns immediately)
// GET  /api/export/:id    -> job status        (poll for the location)
// GET  /api/export/file/:filename -> the file  (download destination)
import { Router } from "express";
import type { Request, Response } from "express";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { isAudience } from "../services/artifact.js";
import { isArtifactKind } from "../services/export-artifacts.js";
import { isDestination } from "../services/export-delivery.js";
import { openExportJobs, type ExportFormat, type ExportRequest } from "../services/export-jobs.js";

const router = Router();
const FORMATS: ExportFormat[] = ["xlsx", "pdf", "pptx"];
const DOWNLOAD_DIR = join(process.cwd(), "data", "exports");

export type ValidationResult =
  | { ok: true; value: ExportRequest }
  | { ok: false; error: string };

export function validateExportRequest(body: unknown): ValidationResult {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isArtifactKind(b.kind)) return { ok: false, error: `unknown artifact kind "${String(b.kind)}"` };
  if (!FORMATS.includes(b.format as ExportFormat)) {
    return { ok: false, error: `unknown format "${String(b.format)}" (expected xlsx, pdf or pptx)` };
  }
  // Deliberately no default: the two audiences contain different data.
  if (!isAudience(b.audience)) {
    return { ok: false, error: `audience is required and must be "internal" or "external"` };
  }
  const destination = b.destination ?? "download";
  if (!isDestination(destination)) return { ok: false, error: `unknown destination "${String(destination)}"` };

  return {
    ok: true,
    value: {
      kind: b.kind,
      format: b.format as ExportFormat,
      audience: b.audience,
      destination,
      account: typeof b.account === "string" ? b.account : undefined,
      vendor: typeof b.vendor === "string" ? b.vendor : undefined,
    },
  };
}

router.post("/", (req: Request, res: Response): void => {
  const result = validateExportRequest(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  const jobs = openExportJobs();
  const jobId = jobs.create(result.value);
  jobs.close();

  // The worker runs detached: a deck takes minutes, so the request must not
  // wait on it. The caller polls GET /api/export/:id.
  void import("../services/export-pipeline.js").then(async ({ runExport }) => {
    const { buildPipelineDeps } = await import("../services/export-wiring.js");
    await runExport(jobId, await buildPipelineDeps());
  });

  res.status(202).json({ jobId });
});

router.get("/file/:filename", (req: Request, res: Response): void => {
  const filename = req.params.filename.replace(/[^a-z0-9._-]/gi, "");
  const path = join(DOWNLOAD_DIR, filename);
  if (!existsSync(path)) {
    res.status(404).json({ error: "no such export" });
    return;
  }
  createReadStream(path).pipe(res);
});

router.get("/:id", (req: Request, res: Response): void => {
  const jobs = openExportJobs();
  const job = jobs.get(req.params.id);
  jobs.close();
  if (job === null) {
    res.status(404).json({ error: "no such job" });
    return;
  }
  res.json(job);
});

export default router;
```

- [ ] **Step 4: Create the wiring module**

```typescript
// src/services/export-wiring.ts
// Binds the pipeline to real services. Kept separate so every unit above stays
// injectable and no test ever reaches a live service.
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gather } from "./export-artifacts.js";
import { deliver } from "./export-delivery.js";
import { openExportJobs } from "./export-jobs.js";
import type { PipelineDeps } from "./export-pipeline.js";
import { renderPdf } from "./render-pdf.js";
import { renderPptx } from "./render-pptx.js";
import { renderXlsx } from "./render-xlsx.js";

export async function buildPipelineDeps(): Promise<PipelineDeps> {
  return {
    jobs: openExportJobs(),
    gather,
    gatherDeps: {
      // Filled in Task 10, which connects the graph and watchlist.
      async incumbency() { return []; },
      async positions() { return []; },
      async news() { return []; },
    },
    // Narration is added in Task 11; until then the artifact passes through
    // unchanged, so the pipeline is end-to-end testable without the model.
    async narrate(artifact) { return artifact; },
    render: { xlsx: renderXlsx, pdf: renderPdf, pptx: renderPptx },
    deliver,
    deliveryDeps: {
      downloadDir: join(process.cwd(), "data", "exports"),
      icloudDir: join(homedir(), "Documents", "PharmaITChat_Artifacts"),
      async writeFile(path, bytes) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      },
      async sendDocument() {
        throw new Error("telegram delivery is wired in Task 12");
      },
    },
  };
}
```

- [ ] **Step 5: Register the route**

In `src/server.ts`, beside the other router imports, add:

```typescript
import exportRouter from "./api/export.js";
```

and beside the `app.use` block (lines 50-55):

```typescript
app.use("/api/export", exportRouter);
```

In `src/api/auth.ts`, add to the protected-routes list beside the `/api/chat` entries:

```typescript
["POST", "/api/export"],
["GET", "/api/export"],
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --testPathPatterns="export-route"` — Expected: PASS (5 tests)
Run: `npm test` — Expected: all suites pass
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 7: Commit**

```bash
git add src/api/export.ts src/services/export-wiring.ts src/server.ts src/api/auth.ts __tests__/export-route.test.ts
git commit -m "feat: export API with async jobs and a required audience"
```

---

### Task 10: Connect the gatherers to real data

**Files:**
- Modify: `src/services/export-wiring.ts` (replace the three stub `gatherDeps` methods)
- Test: `__tests__/export-wiring.test.ts`

**Interfaces:**
- Consumes: `GatherDeps` (Task 6)
- Produces: `buildGatherDeps(reader: { runCypher(query: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>; itemsFor(entity: string, limit: number): Array<{ title: string; url: string; publishedAt: string }> }): GatherDeps`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { buildGatherDeps } from "../src/services/export-wiring.js";

describe("buildGatherDeps", () => {
  it("maps cypher rows into incumbency entries", async () => {
    const deps = buildGatherDeps({
      async runCypher() {
        return [{ account: "roche", segment: "storage-file", vendors: ["dell"] }];
      },
      itemsFor() {
        return [];
      },
    });

    expect(await deps.incumbency()).toEqual([
      { account: "roche", segment: "storage-file", vendors: ["dell"] },
    ]);
  });

  it("maps cypher rows into positions", async () => {
    const deps = buildGatherDeps({
      async runCypher() {
        return [{ segment: "storage-file", position: "strong", confidence: "medium", rationale: "Contested." }];
      },
      itemsFor() {
        return [];
      },
    });

    expect(await deps.positions("dell")).toEqual([
      { segment: "storage-file", position: "strong", confidence: "medium", rationale: "Contested." },
    ]);
  });

  it("reads recent items for an entity from the watchlist", async () => {
    const deps = buildGatherDeps({
      async runCypher() {
        return [];
      },
      itemsFor(entity, limit) {
        expect(entity).toBe("roche");
        expect(limit).toBe(5);
        return [{ title: "Roche builds AI factory", url: "https://example.test/a", publishedAt: "2026-09-20" }];
      },
    });

    expect(await deps.news("roche", 5)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-wiring"`
Expected: FAIL — "buildGatherDeps is not a function"

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/export-wiring.ts`:

```typescript
import type { GatherDeps } from "./export-artifacts.js";

export interface GraphReader {
  runCypher(query: string, params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  itemsFor(entity: string, limit: number): Array<{ title: string; url: string; publishedAt: string }>;
}

const INCUMBENCY_CYPHER = `
  MATCH (a:Account)-[u:USES]->(v:Vendor)
  RETURN a.id AS account, u.segment AS segment, collect(v.id) AS vendors
  ORDER BY account, segment
`;

const POSITIONS_CYPHER = `
  MATCH (v:Vendor {id: $vendor})-[c:COMPETES_IN]->(s:Segment)
  RETURN s.id AS segment, c.position AS position, c.confidence AS confidence, c.rationale AS rationale
  ORDER BY segment
`;

export function buildGatherDeps(reader: GraphReader): GatherDeps {
  return {
    async incumbency() {
      const rows = await reader.runCypher(INCUMBENCY_CYPHER);
      return rows.map((r) => ({
        account: String(r.account),
        segment: String(r.segment),
        vendors: Array.isArray(r.vendors) ? r.vendors.map(String) : [],
      }));
    },
    async positions(vendor) {
      const rows = await reader.runCypher(POSITIONS_CYPHER, { vendor });
      return rows.map((r) => ({
        segment: String(r.segment),
        position: String(r.position),
        confidence: String(r.confidence),
        rationale: String(r.rationale ?? ""),
      }));
    },
    async news(entity, limit) {
      return reader.itemsFor(entity, limit);
    },
  };
}
```

Then replace the stub `gatherDeps` in `buildPipelineDeps`:

```typescript
import neo4j from "neo4j-driver";
import { openWatchlistStore } from "./watchlist-store.js";

// Same connection settings as graph-store.ts lines 6-8.
function liveReader(): GraphReader {
  const driver = neo4j.driver(
    process.env.NEO4J_URI ?? "bolt://localhost:7687",
    neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD ?? "pharma2024"),
  );
  return {
    async runCypher(query, params = {}) {
      const session = driver.session({ defaultAccessMode: neo4j.session.READ });
      try {
        const result = await session.run(query, params);
        return result.records.map((r) => r.toObject() as Record<string, unknown>);
      } finally {
        await session.close();
      }
    },
    itemsFor(entity, limit) {
      const store = openWatchlistStore();
      try {
        // Widest window the store supports; the caller decides how many to keep.
        return store
          .itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z")
          .filter((item) => item.entities.includes(entity))
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
          .slice(0, limit)
          .map((item) => ({ title: item.title, url: item.urlCanonical, publishedAt: item.publishedAt.slice(0, 10) }));
      } finally {
        store.close();
      }
    },
  };
}
```

and in `buildPipelineDeps`, replace the three stub methods with `gatherDeps: buildGatherDeps(liveReader()),`.

- [ ] **Step 4: Run tests**

Run: `npm test -- --testPathPatterns="export-wiring"` — Expected: PASS (3 tests)
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 5: Verify end to end against live data**

```bash
curl -s -X POST -H "Authorization: Bearer $(cat data/run/api-token)" \
  -H "Content-Type: application/json" \
  -d '{"kind":"incumbency-matrix","format":"xlsx","audience":"internal"}' \
  http://localhost:3000/api/export
```

Expected: `{"jobId":"..."}`. Then poll `GET /api/export/<jobId>` until `stage` is `done`, and confirm the file exists in `data/exports/`.

- [ ] **Step 6: Commit**

```bash
git add src/services/export-wiring.ts __tests__/export-wiring.test.ts
git commit -m "feat: wire export gatherers to the graph and watchlist"
```

---

### Task 11: LLM narration

**Files:**
- Modify: `src/services/export-wiring.ts` (replace the pass-through `narrate`)
- Create: `src/services/export-narrative.ts`
- Test: `__tests__/export-narrative.test.ts`

**Interfaces:**
- Consumes: `Artifact` (Task 1)
- Produces: `narrateArtifact(artifact: Artifact, chat: (prompt: string) => Promise<string>): Promise<Artifact>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { narrateArtifact } from "../src/services/export-narrative.js";
import type { Artifact } from "../src/services/artifact.js";

const artifact: Artifact = {
  title: "Roche — brief",
  audience: "external",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [
    { kind: "table", heading: "Recent developments", columns: ["date", "headline"], rows: [["2026-09-20", "AI factory"]] },
  ],
  citations: [{ id: "c1", title: "Blocks & Files", url: "https://example.test/a" }],
};

describe("narrateArtifact", () => {
  it("prepends a prose section written by the model", async () => {
    const result = await narrateArtifact(artifact, async () => "Roche is scaling its AI estate.");

    expect(result.sections[0]).toEqual({
      kind: "prose",
      heading: "Summary",
      body: "Roche is scaling its AI estate.",
      cites: ["c1"],
    });
  });

  it("keeps the original sections after the summary", async () => {
    const result = await narrateArtifact(artifact, async () => "text");

    expect(result.sections).toHaveLength(2);
    expect(result.sections[1].heading).toBe("Recent developments");
  });

  // The model must never be handed internal data for an external artifact; the
  // gatherer already omitted it, and this asserts the prompt reflects that.
  it("gives the model the artifact's own facts and nothing else", async () => {
    let seen = "";
    await narrateArtifact(artifact, async (prompt) => {
      seen = prompt;
      return "text";
    });

    expect(seen).toContain("AI factory");
    expect(seen).not.toContain("incumben");
  });

  it("returns the artifact unchanged when the model returns nothing", async () => {
    const result = await narrateArtifact(artifact, async () => "   ");

    expect(result.sections).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-narrative"`
Expected: FAIL — "Cannot find module '../src/services/export-narrative.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// The one step that calls the model. It sees only the artifact's own facts, so
// an external artifact cannot be narrated from internal data -- the gatherer
// already omitted it and there is nothing else in scope.
import type { Artifact } from "./artifact.js";

function factsAsText(artifact: Artifact): string {
  const lines: string[] = [];
  for (const section of artifact.sections) {
    lines.push(`## ${section.heading}`);
    if (section.kind === "table") {
      lines.push(section.columns.join(" | "));
      for (const row of section.rows) lines.push(row.join(" | "));
    }
    if (section.kind === "facts") for (const i of section.items) lines.push(`${i.label}: ${i.value}`);
    if (section.kind === "prose") lines.push(section.body);
  }
  return lines.join("\n");
}

export async function narrateArtifact(
  artifact: Artifact,
  chat: (prompt: string) => Promise<string>,
): Promise<Artifact> {
  const prompt = [
    `Write a short summary for a document titled "${artifact.title}".`,
    `Audience: ${artifact.audience === "external" ? "the customer" : "an internal account team"}.`,
    "Use only the facts below. Do not invent figures, dates or product names.",
    "",
    factsAsText(artifact),
  ].join("\n");

  const body = (await chat(prompt)).trim();
  if (body.length === 0) return artifact;

  return {
    ...artifact,
    sections: [
      { kind: "prose", heading: "Summary", body, cites: artifact.citations.map((c) => c.id) },
      ...artifact.sections,
    ],
  };
}
```

Then in `export-wiring.ts`, replace the pass-through with:

```typescript
async narrate(artifact) {
  const llm = getLlmClient();
  return narrateArtifact(artifact, async (prompt) => llm.chat([{ role: "user", content: prompt }]));
},
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --testPathPatterns="export-narrative"` — Expected: PASS (4 tests)
Run: `npm test` — Expected: all suites pass
Run: `npm run typecheck` — Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/services/export-narrative.ts src/services/export-wiring.ts __tests__/export-narrative.test.ts
git commit -m "feat: model-written summary from the artifact's own facts"
```

---

### Task 12: Telegram delivery and the MCP tool

**Files:**
- Modify: `src/services/export-wiring.ts` (implement `sendDocument`)
- Create: `mcp/src/tools/export.ts`
- Modify: `mcp/src/server.ts` (register the tool beside the existing `registerXxxTools` calls)
- Test: `__tests__/export-telegram.test.ts`

**Interfaces:**
- Consumes: `DeliveryDeps["sendDocument"]` (Task 5)
- Produces: `sendTelegramDocument(filename: string, bytes: Buffer, config: { botToken: string; chatId: string }, fetchImpl: typeof fetch): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { sendTelegramDocument } from "../src/services/export-wiring.js";

describe("sendTelegramDocument", () => {
  it("posts the file to sendDocument with the chat id", async () => {
    let seenUrl = "";
    let seenBody: FormData | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenBody = (init?.body ?? null) as FormData | null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await sendTelegramDocument("roche-brief.pdf", Buffer.from("x"), { botToken: "T", chatId: "42" }, fakeFetch);

    expect(seenUrl).toBe("https://api.telegram.org/botT/sendDocument");
    expect(seenBody?.get("chat_id")).toBe("42");
  });

  it("throws when telegram rejects the upload", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;

    await expect(
      sendTelegramDocument("a.pdf", Buffer.from("x"), { botToken: "T", chatId: "42" }, fakeFetch),
    ).rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPatterns="export-telegram"`
Expected: FAIL — "sendTelegramDocument is not a function"

- [ ] **Step 3: Write minimal implementation**

Add to `src/services/export-wiring.ts`:

```typescript
/**
 * Upload a rendered file to Telegram. Separate from telegram-notify.ts, which
 * sends text: sendDocument needs multipart, not JSON.
 */
export async function sendTelegramDocument(
  filename: string,
  bytes: Buffer,
  config: { botToken: string; chatId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const form = new FormData();
  form.set("chat_id", config.chatId);
  form.set("document", new Blob([bytes]), filename);

  const resp = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) throw new Error(`telegram sendDocument failed (${resp.status})`);
}
```

and replace the stub in `buildPipelineDeps`:

```typescript
async sendDocument(filename, bytes) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  if (!botToken || !chatId) throw new Error("telegram delivery needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  await sendTelegramDocument(filename, bytes, { botToken, chatId });
},
```

- [ ] **Step 4: Add the MCP tool**

Create `mcp/src/tools/export.ts`, following the shape of `mcp/src/tools/gaps.ts`:

```typescript
import { z } from "zod";

// Parameter types follow mcp/src/tools/gaps.ts exactly; copy its import block
// and signature rather than inventing names.
export function registerExportTools(
  server: McpServer,
  client: PharmaITChatClient,
  log: Logger,
  options: ToolOptions,
): void {
  server.registerTool(
    "create_artifact",
    {
      description:
        "Produce a document from PharmaITChat's data: an account brief, incumbency matrix or vendor " +
        "comparison, as xlsx, pdf or pptx. `audience` is required -- 'internal' includes incumbency and " +
        "competitive position, 'external' omits them for something a customer may see. Returns a job id; " +
        "a deck takes several minutes. Poll with artifact_status.",
      inputSchema: {
        kind: z.enum(["account-brief", "incumbency-matrix", "vendor-comparison"]),
        format: z.enum(["xlsx", "pdf", "pptx"]),
        audience: z.enum(["internal", "external"]),
        destination: z.enum(["download", "telegram", "icloud"]).optional(),
        account: z.string().optional(),
        vendor: z.string().optional(),
      },
    },
    async (args) => client.post("/api/export", args),
  );

  server.registerTool(
    "artifact_status",
    {
      description: "Check an export job: its stage, and where the finished file went.",
      inputSchema: { job_id: z.string().min(1) },
    },
    async ({ job_id }) => client.get(`/api/export/${job_id}`),
  );
}
```

Register it in `mcp/src/server.ts` beside the other `registerXxxTools(...)` calls.

- [ ] **Step 5: Run tests**

Run: `npm test -- --testPathPatterns="export-telegram"` — Expected: PASS (2 tests)
Run: `npm test` — Expected: all suites pass
Run: `npm run typecheck` — Expected: no output
Run: `cd mcp && npm test && cd ..` — Expected: MCP suites pass

- [ ] **Step 6: Verify end to end from Telegram**

Restart the app so the new routes load, then from Telegram ask:

> "Make me an internal account brief for Roche as a PDF and send it here"

Expected: the agent calls `create_artifact` with `destination: "telegram"`, replies with a job id, and the PDF arrives as a document within a few minutes.

- [ ] **Step 7: Commit**

```bash
git add src/services/export-wiring.ts mcp/src/tools/export.ts mcp/src/server.ts __tests__/export-telegram.test.ts
git commit -m "feat: telegram document delivery and the create_artifact MCP tool"
```

---

## Notes for the executor

**Run the ingest and long exports when nobody is using chat.** MLX serves one request at a time; the watchlist tagger saturates it for ~20s per item, and narration for a deck can run for minutes. An export started while an ingest is running will simply wait.

**The MLX watchdog stands down during an ingest** (`scripts/mlx-watchdog.sh`) but not during an export. If a long narration ever trips it, add `export-pipeline` to the same stand-down check rather than lengthening the probe timeout.

**Chart rendering is deliberately deferred.** The spec calls for charts as SVG
(never PNG, which would need node-canvas and native Cairo), and the `chart`
section kind exists in the artifact model so it can be added without changing
anything else. No gatherer emits one yet, so all three renderers write a
placeholder line. Implementing an unused renderer would be building code with no
caller; add it in the same task as the first gatherer that needs a chart, and
keep SVG.

**Two behaviours are deliberate and must not be "fixed":**
- `audience` has no default. A request without it is a 400.
- There is no review gate on model-written content. That is a recorded decision in the spec, with its known failure mode.
