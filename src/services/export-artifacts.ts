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

// R1 (final review, important 3): which kinds have no external form was
// expressed twice as two hand-written throws below, and nowhere the HTTP
// layer could consult -- so a request that was known-invalid at validation
// time was accepted with a 202 and a job id, then failed minutes later in
// the gathering stage. src/api/export.ts now refuses the combination up
// front using the predicate below, and the gatherer keeps its throw: this
// module stays the authority, the route is only a fast-fail in front of it.
// Both read the SAME predicate and the SAME message, so there is nothing for
// them to disagree about; __tests__/export-route.test.ts pins that agreement
// by comparing the validator's verdict against what gather() actually does
// for every kind in ARTIFACT_KINDS.
//
// Why these two: a vendor comparison IS competitive framing, and a table of
// who holds which account IS incumbency information. Strip that out for an
// external reader and nothing is left to call by either name, so the answer
// is a refusal, not a thinner artifact.
const INTERNAL_ONLY_KINDS: readonly ArtifactKind[] = ["incumbency-matrix", "vendor-comparison"];

export function hasExternalForm(kind: ArtifactKind): boolean {
  return !INTERNAL_ONLY_KINDS.includes(kind);
}

export function internalOnlyKindMessage(kind: ArtifactKind): string {
  return `${kind} is internal by nature; there is no external version`;
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
  // No external form at all (see INTERNAL_ONLY_KINDS above, which is also
  // what the API's validation consults so a caller hears this at request
  // time rather than minutes later).
  if (audience === "external" && !hasExternalForm(kind)) {
    throw new Error(internalOnlyKindMessage(kind));
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
  if (audience === "external" && !hasExternalForm("incumbency-matrix")) {
    throw new Error(internalOnlyKindMessage("incumbency-matrix"));
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
