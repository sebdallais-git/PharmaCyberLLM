// Artifact -> .pdf. Deliberately plain: a one-pager whose value is the facts,
// not the typography. Text is wrapped by hand because pdf-lib draws strings at
// coordinates and does no layout of its own.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { assertExternalSafe, type Artifact } from "./artifact.js";

const MARGIN = 50;
const BODY = 11;
const HEADING = 14;

// ASCII stand-ins for symbols that model-written text uses and WinAnsi lacks
const SUBSTITUTES: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>",
  "≥": ">=", "≤": "<=", "≠": "!=", "≈": "~",
  "↑": "up", "↓": "down",
};

// The standard fonts only encode WinAnsi, and pdf-lib throws on anything else
// (CJK, emoji, arrows), which failed the whole export. Keep what the font can
// draw, substitute the common symbols, and mark the rest with "?".
export function toDrawable(text: string, supported: ReadonlySet<number>): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code !== undefined && supported.has(code)) out += ch;
    else out += SUBSTITUTES[ch] ?? "?";
  }
  return out;
}

// Word-wraps text to at most `max` characters per line. A word that alone
// exceeds `max` (e.g. a long URL with no spaces) is hard-split into
// `max`-sized chunks instead of being left to overflow the margin or
// triggering a spurious blank line ahead of it.
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= max) {
      line = candidate;
      continue;
    }

    if (line) out.push(line);

    if (word.length > max) {
      let rest = word;
      while (rest.length > max) {
        out.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      line = rest;
    } else {
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

export async function renderPdf(artifact: Artifact): Promise<Buffer> {
  assertExternalSafe(artifact);

  const doc = await PDFDocument.create();
  doc.setTitle(artifact.title);
  doc.setCreationDate(new Date(artifact.generatedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // Helvetica and Helvetica-Bold share the WinAnsi character set
  const drawable = new Set(font.getCharacterSet());

  let page = doc.addPage();
  let y = page.getHeight() - MARGIN;

  const newPage = () => {
    page = doc.addPage();
    y = page.getHeight() - MARGIN;
  };

  const write = (text: string, size: number, useBold = false) => {
    for (const line of wrap(toDrawable(text, drawable), size === HEADING ? 70 : 95)) {
      if (y < MARGIN) newPage();
      page.drawText(line, { x: MARGIN, y, size, font: useBold ? bold : font, color: rgb(0, 0, 0) });
      y -= size + 4;
    }
  };

  // Keep-with-next guard: a heading with nothing under it is worse than no
  // heading at all. Before writing one, require room for the heading's own
  // (possibly wrapped) lines plus at least one more line of body content;
  // otherwise start a fresh page first, rather than let `write`'s per-line
  // check strand the heading alone at the bottom of the current page.
  const writeHeading = (text: string) => {
    const headingLines = wrap(toDrawable(text, drawable), 70);
    const needed = headingLines.length * (HEADING + 4) + (BODY + 4);
    if (y - needed < MARGIN) newPage();
    write(text, HEADING, true);
  };

  write(artifact.title, HEADING + 4, true);
  if (artifact.subtitle) write(artifact.subtitle, BODY);
  y -= 10;

  for (const section of artifact.sections) {
    writeHeading(section.heading);
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
    writeHeading("Sources");
    for (const cite of artifact.citations) write(`[${cite.id}] ${cite.title} — ${cite.url}`, BODY);
  }

  return Buffer.from(await doc.save());
}
