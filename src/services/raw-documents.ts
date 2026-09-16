// Raw document store: the on-disk source of truth that per-stack indexes are rebuilt from

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RawDocument {
  source: string;
  content: string;
  metadata: Record<string, unknown>;
  saved_at: string;
}

export interface SaveOptions {
  // Identity of the document; defaults to the source. News uses the article URL,
  // because every article from one day shares the same source name.
  key?: string;
  dir?: string;
}

export const RAW_DOCUMENTS_DIR = join(process.cwd(), "data", "raw_documents");

export function rawDocumentFilename(key: string): string {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`;
}

export async function saveRawDocument(
  source: string,
  content: string,
  metadata: Record<string, unknown> = {},
  options: SaveOptions = {}
): Promise<void> {
  const dir = options.dir ?? RAW_DOCUMENTS_DIR;
  await mkdir(dir, { recursive: true });
  const doc: RawDocument = { source, content, metadata, saved_at: new Date().toISOString() };
  await writeFile(join(dir, rawDocumentFilename(options.key ?? source)), JSON.stringify(doc), "utf-8");
}

function isRawDocument(value: unknown): value is RawDocument {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as Record<string, unknown>;
  return typeof doc.source === "string" && typeof doc.content === "string";
}

export async function listRawDocuments(dir: string = RAW_DOCUMENTS_DIR): Promise<RawDocument[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const docs: RawDocument[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), "utf-8")) as unknown;
      if (!isRawDocument(parsed)) throw new Error("missing source or content");
      docs.push({
        source: parsed.source,
        content: parsed.content,
        metadata: parsed.metadata ?? {},
        saved_at: parsed.saved_at ?? "",
      });
    } catch (err) {
      console.warn(`[Raw Documents] Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return docs;
}
