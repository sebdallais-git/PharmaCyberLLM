// Gatherers turn the system's data into an Artifact. This is the only layer
// that knows about vendors, accounts and segments; a later task swaps the
// GatherDeps implementations for real Neo4j and watchlist queries, but the
// shape produced here does not change.
//
// The audience filter lives here, not at render time: an external artifact
// never contains incumbency, confidence, or defend/displace/greenfield
// framing, because those sections are simply never built when audience is
// "external". Renderers still call assertExternalSafe() as a backstop
// against a bug in this file (see artifact.ts), but that is a safety net,
// not the control — the sections it would catch are never constructed here
// in the first place.
import type { Artifact, Audience, Citation, Section } from "./artifact.js";

export const ARTIFACT_KINDS = ["account-brief", "incumbency-matrix", "vendor-comparison"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export interface GatherDeps {
  incumbency(): Promise<Array<{ account: string; segment: string; vendors: string[] }>>;
  positions(
    vendor: string,
  ): Promise<Array<{ segment: string; position: string; confidence: string; rationale: string }>>;
  news(entity: string, limit: number): Promise<Array<{ title: string; url: string; publishedAt: string }>>;
}

interface GatherOptions {
  account?: string;
  vendor?: string;
}

// No option that identifies a vendor or an account may default silently: a
// missing one must fail loudly, naming what was missing, rather than
// falling back to a hardcoded vendor or an empty-string filter that quietly
// produces a thin or wrong artifact.
function requireOption(value: string | undefined, name: "account" | "vendor", needed: boolean): string {
  if (!needed) return "";
  if (value === undefined || value === "") {
    throw new Error(`gather: missing required option "${name}"`);
  }
  return value;
}

// News is the only source that is safe for both audiences: it is public
// reporting, not our own assessment of an account.
function citationsFrom(items: Array<{ title: string; url: string }>): Citation[] {
  return items.map((item, i) => ({ id: `c${i + 1}`, title: item.title, url: item.url }));
}

function newsSection(news: Array<{ title: string; publishedAt: string }>): Section {
  return {
    kind: "table",
    heading: "Recent developments",
    columns: ["date", "headline"],
    rows: news.map((n) => [n.publishedAt, n.title]),
  };
}

// Internal-only: which vendor is installed per segment for one account. The
// caller must not invoke this for an external audience.
function incumbencySection(rows: Array<{ segment: string; vendors: string[] }>): Section {
  return {
    kind: "table",
    heading: "Incumbency by segment",
    columns: ["segment", "installed"],
    rows: rows.map((r) => [r.segment, r.vendors.join("+")]),
  };
}

// Internal-only: position, confidence and rationale per segment for one
// vendor. The rationale is free text and may itself use defend/displace/
// greenfield language; that is fine only because this section is never
// attached to an external artifact. The caller must not invoke this for an
// external audience.
function competitivePositionSection(
  positions: Array<{ segment: string; position: string; confidence: string; rationale: string }>,
): Section {
  return {
    kind: "table",
    heading: "Competitive position",
    columns: ["segment", "position", "confidence", "rationale"],
    rows: positions.map((p) => [p.segment, p.position, p.confidence, p.rationale]),
  };
}

// Shared by "account-brief" and "vendor-comparison": both are a view onto one
// account/vendor pair, differing only in title and in which side of the pair
// they are named after. The internal-only sections are built up inside the
// `audience === "internal"` branch and nowhere else — an external gather
// never enters it, so there is nothing to strip out afterwards.
async function gatherAccountOrVendorView(
  kind: "account-brief" | "vendor-comparison",
  audience: Audience,
  options: GatherOptions,
  deps: GatherDeps,
): Promise<Artifact> {
  // A vendor comparison IS competitive framing; once that framing is
  // stripped for an external audience there is nothing left to call a
  // comparison, so this kind has no external form at all — same rule as
  // incumbency-matrix below.
  if (kind === "vendor-comparison" && audience === "external") {
    throw new Error("vendor-comparison is internal by nature; there is no external version");
  }

  // account-brief is identified by account, vendor-comparison by vendor.
  // Whichever kind, an internal gather additionally builds the other axis
  // (the account's incumbency table, the vendor's competitive position), so
  // an internal audience requires both regardless of which one names the
  // title.
  const account = requireOption(options.account, "account", kind === "account-brief" || audience === "internal");
  const vendor = requireOption(options.vendor, "vendor", kind === "vendor-comparison" || audience === "internal");

  const news = await deps.news(kind === "account-brief" ? account : vendor, 10);
  const sections: Section[] = [];

  if (audience === "internal") {
    const incumbency = (await deps.incumbency()).filter((r) => r.account === account);
    sections.push(incumbencySection(incumbency));

    const positions = await deps.positions(vendor);
    sections.push(competitivePositionSection(positions));
  }

  sections.push(newsSection(news));

  const title = kind === "vendor-comparison" ? `${vendor} — competitive view` : `${account} — brief`;

  return {
    title,
    audience,
    generatedAt: new Date().toISOString(),
    sections,
    citations: citationsFrom(news),
  };
}

// "incumbency-matrix" has no external form at all: a table of who holds which
// account IS incumbency information, so there is nothing to gather for an
// external audience — this throws rather than returning a thinner artifact.
async function gatherIncumbencyMatrix(audience: Audience, deps: GatherDeps): Promise<Artifact> {
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
      ...accounts.map(
        (account) => rows.find((r) => r.account === account && r.segment === segment)?.vendors.join("+") ?? "",
      ),
    ]),
  };

  return {
    title: "Incumbency matrix",
    audience,
    generatedAt: new Date().toISOString(),
    sections: [table],
    citations: [],
  };
}

export async function gather(
  kind: ArtifactKind,
  audience: Audience,
  options: GatherOptions,
  deps: GatherDeps,
): Promise<Artifact> {
  if (kind === "incumbency-matrix") {
    return gatherIncumbencyMatrix(audience, deps);
  }
  return gatherAccountOrVendorView(kind, audience, options, deps);
}
