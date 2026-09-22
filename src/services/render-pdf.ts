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
