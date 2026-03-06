// Parses various file formats into plain text for ingestion

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// These CJS modules need require() for ESM compatibility
const pdfParseModule = require("pdf-parse") as { PDFParse: new (opts: { data: Uint8Array }) => { getText: () => Promise<{ text: string }> } };
const mammoth = require("mammoth") as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> };
const JSZip = require("jszip") as typeof import("jszip");

const SUPPORTED_EXTENSIONS = [".txt", ".md", ".pdf", ".csv", ".json", ".docx", ".pptx", ".ppt"];

export function isSupportedFile(filename: string): boolean {
  const ext = getExtension(filename);
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export function getSupportedExtensions(): string[] {
  return [...SUPPORTED_EXTENSIONS];
}

function getExtension(filename: string): string {
  return filename.substring(filename.lastIndexOf(".")).toLowerCase();
}

export async function parseFile(filePath: string): Promise<string> {
  const ext = getExtension(filePath);

  switch (ext) {
    case ".txt":
    case ".md":
      return readFile(filePath, "utf-8");

    case ".pdf":
      return parsePdf(filePath);

    case ".csv":
      return parseCsv(filePath);

    case ".json":
      return parseJson(filePath);

    case ".docx":
      return parseDocx(filePath);

    case ".pptx":
    case ".ppt":
      return parsePptx(filePath);

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

export async function parseBuffer(buffer: Buffer, filename: string): Promise<string> {
  const ext = getExtension(filename);

  switch (ext) {
    case ".txt":
    case ".md":
      return buffer.toString("utf-8");

    case ".pdf":
      return pdfBufferToText(buffer);

    case ".csv":
      return csvToText(buffer.toString("utf-8"));

    case ".json":
      return jsonToText(buffer.toString("utf-8"));

    case ".docx":
      return (await mammoth.extractRawText({ buffer })).value;

    case ".pptx":
    case ".ppt":
      return extractPptxText(buffer);

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

async function pdfBufferToText(buffer: Buffer): Promise<string> {
  const parser = new pdfParseModule.PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
}

async function parsePdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return pdfBufferToText(buffer);
}

async function parseDocx(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function parsePptx(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return extractPptxText(buffer);
}

// Extract text from PPTX slides (PPTX is a ZIP of XML files)
async function extractPptxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideTexts: string[] = [];

  // Slides are stored as ppt/slides/slide1.xml, slide2.xml, etc.
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] ?? "0");
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] ?? "0");
      return numA - numB;
    });

  for (const slideFile of slideFiles) {
    const xml = await zip.files[slideFile].async("text");
    // Extract text content from XML tags like <a:t>text</a:t>
    const texts: string[] = [];
    const regex = /<a:t>([^<]*)<\/a:t>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
      if (match[1].trim()) {
        texts.push(match[1].trim());
      }
    }
    if (texts.length > 0) {
      const slideNum = slideFile.match(/slide(\d+)/)?.[1] ?? "?";
      slideTexts.push(`[Slide ${slideNum}]\n${texts.join(" ")}`);
    }
  }

  return slideTexts.join("\n\n");
}

function parseCsv(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8").then(csvToText);
}

// Convert CSV rows into readable text
function csvToText(raw: string): string {
  const lines = raw.trim().split("\n");
  if (lines.length === 0) return "";

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1);

  return rows
    .map((row) => {
      const values = row.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      return headers.map((h, i) => `${h}: ${values[i] ?? ""}`).join(", ");
    })
    .join("\n");
}

function parseJson(filePath: string): Promise<string> {
  return readFile(filePath, "utf-8").then(jsonToText);
}

// Flatten JSON into readable text
function jsonToText(raw: string): string {
  const data: unknown = JSON.parse(raw);

  if (Array.isArray(data)) {
    return data.map((item) => flattenObject(item as Record<string, unknown>)).join("\n\n");
  }

  if (typeof data === "object" && data !== null) {
    return flattenObject(data as Record<string, unknown>);
  }

  return String(data);
}

function flattenObject(obj: Record<string, unknown>, prefix: string = ""): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      lines.push(flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      lines.push(`${fullKey}: ${String(value)}`);
    }
  }

  return lines.join("\n");
}
