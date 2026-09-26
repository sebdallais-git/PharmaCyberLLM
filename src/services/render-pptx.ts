// Artifact -> .pptx. One slide per section, plus a title slide and a sources
// slide. pptxgenjs writes a real Office file with no Office installed.
import PptxGenJS from "pptxgenjs";
import { assertExternalSafe, type Artifact } from "./artifact.js";

// buildPptx exposes the slide count alongside the buffer so a test can assert
// on layout (title + one per section + sources) without unzipping the file.
export interface PptxResult {
  buffer: Buffer;
  slideCount: number;
}

export async function buildPptx(artifact: Artifact): Promise<PptxResult> {
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
          x: 0.5,
          y: 1.4,
          w: 9,
          h: 4,
          fontSize: 14,
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
      x: 0.5,
      y: 1.4,
      w: 9,
      h: 4,
      fontSize: 11,
    });
  }

  const buffer = (await deck.write({ outputType: "nodebuffer" })) as Buffer;
  return { buffer, slideCount };
}

export async function renderPptx(artifact: Artifact): Promise<Buffer> {
  return (await buildPptx(artifact)).buffer;
}
