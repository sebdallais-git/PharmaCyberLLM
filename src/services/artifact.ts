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

// R1 (final review, minor 5): the "chart" section kind above is RESERVED and
// currently unproduced -- no gatherer builds one, so the chart branch in all
// three renderers is unreachable today. That is deliberate, not an
// oversight: this artifact model is the documented extension point between
// gathering and rendering, and the export spec names charts explicitly, so
// the kind and its renderer branches stay. A gatherer that emits one needs no
// change here or in any renderer.

// Words that must never appear in an external artifact's structure. The
// gatherer omits these sections rather than redacting them, so this is a
// backstop against a gatherer bug, not the primary control. Every section
// kind is scanned, including model-written prose and chart specs, as are the
// artifact's own title and subtitle -- and its citations (R2, final review,
// important 5): every renderer emits the citation list into the document, so
// a citation title or url is as visible to a customer as a heading. They
// come from public news items today, which is why this was missed; the
// guard's job is to scan everything the artifact carries, whatever its
// current provenance.
const INTERNAL_ONLY = ["incumben", "confidence", "displace", "defend", "greenfield"];

export function assertExternalSafe(artifact: Artifact): void {
  if (artifact.audience !== "external") return;

  // The title and subtitle are rendered as prominently as any section: the PDF
  // writes the title into the document metadata, the deck puts it on slide 1.
  const haystack: string[] = [artifact.title];
  if (artifact.subtitle !== undefined) haystack.push(artifact.subtitle);
  for (const section of artifact.sections) {
    haystack.push(section.heading);
    if (section.kind === "table") haystack.push(...section.columns, ...section.rows.flat());
    if (section.kind === "facts") haystack.push(...section.items.map((i) => `${i.label} ${i.value}`));
    if (section.kind === "prose") haystack.push(section.body);
    if (section.kind === "chart") haystack.push(JSON.stringify(section.spec));
  }
  for (const citation of artifact.citations) haystack.push(citation.title, citation.url);

  for (const term of INTERNAL_ONLY) {
    const hit = haystack.find((text) => text.toLowerCase().includes(term));
    if (hit !== undefined) {
      throw new Error(`external artifact contains internal-only content ("${term}" in "${hit}")`);
    }
  }
}
