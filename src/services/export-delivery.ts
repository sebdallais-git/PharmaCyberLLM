// Where a rendered file goes. Three strategies behind one call, so the pipeline
// does not branch on destination.
import { basename, join, resolve, sep } from "node:path";

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

// RenderedFile.filename is derived upstream from a model-written artifact
// title: it must never be trusted as a path. Strip it to a bare basename
// (dropping any directory separators or ".." segments) before joining it onto
// a destination directory, then resolve the result and confirm it still lives
// inside that directory. The resolve()+prefix check is a defensive backstop —
// basename() alone should already make escape impossible — kept because a
// silent regression here is a real filesystem write outside the intended
// folder, not just a wrong return value.
function resolveDestinationPath(dir: string, filename: string): string {
  const safeName = basename(filename);
  const resolvedDir = resolve(dir);
  const resolvedPath = resolve(resolvedDir, safeName);

  if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(resolvedDir + sep)) {
    throw new Error(`refusing to deliver outside destination directory: ${filename}`);
  }

  return resolvedPath;
}

/** Returns a human-readable location: a URL, "telegram", or an absolute path. */
export async function deliver(
  file: RenderedFile,
  destination: Destination,
  deps: DeliveryDeps,
): Promise<string> {
  switch (destination) {
    case "download": {
      const path = resolveDestinationPath(deps.downloadDir, file.filename);
      await deps.writeFile(path, file.bytes);
      return `/api/export/file/${basename(path)}`;
    }
    case "icloud": {
      // This is an egress path: anything written under ~/Documents leaves the
      // Mac via iCloud sync (that is how it reaches the user's iPad). No
      // convenience copy elsewhere — this is the one place these bytes go.
      const path = resolveDestinationPath(deps.icloudDir, file.filename);
      await deps.writeFile(path, file.bytes);
      return path;
    }
    case "telegram": {
      await deps.sendDocument(file.filename, file.bytes);
      return "telegram";
    }
  }
}
