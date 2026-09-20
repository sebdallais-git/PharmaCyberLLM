// EDGAR (SEC full-text/submissions API) and IR-page adapters.
//
// Two very different sources, kept in one module because both feed the same
// "a filing/report just appeared" signal that rss/newsAdapter (Task 4) cover
// for press releases: edgarAdapter reads a structured JSON API, irPageAdapter
// scrapes an unstructured investor-relations results page. Shared helpers
// (canonicalUrl, contentHash, titleKey, the fetch/timeout machinery) live in
// watchlist-sources.ts and are imported, not re-implemented.

import type { Entity } from "./watchlist-config.js";
import { fetchBody, MAX_ITEM_BODY_LENGTH, titleKey, type AdapterDeps, type RawItem } from "./watchlist-sources.js";

// ---- EDGAR submissions adapter ----------------------------------------------

// The SEC requires a declaring User-Agent (company/application + contact)
// and returns 403 without one -- this is stricter than the general feed
// User-Agent (DEFAULT_USER_AGENT in watchlist-sources.ts), which is a
// generic browser-like string that satisfies ordinary newsroom/IR hosts but
// not data.sec.gov. See https://www.sec.gov/os/webmaster-faq#developers.
export const EDGAR_USER_AGENT = "PharmaLLM/1.0 (sebdallais@gmail.com)";

// The SEC also rate-limits at 10 requests/second across all of EDGAR (not
// per-CIK). This adapter makes exactly one request per call, so throttling
// across the ~46 EDGAR-filing entities in config/watchlist.yaml is the
// orchestrator's responsibility (a later task), not this module's -- there
// is no shared state here to serialize requests through.

const FORMS_OF_INTEREST = new Set(["8-K", "10-Q", "10-K", "6-K", "20-F"]);

interface EdgarSubmissionsRecent {
  form: string[];
  filingDate: string[];
  reportDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
}

interface EdgarSubmissions {
  recent: EdgarSubmissionsRecent;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validates just enough of the submissions JSON shape to safely zip the
// parallel arrays below. EDGAR's actual payload carries many more fields
// (name, tickers, filings.files for older filings, ...); only
// filings.recent's five parallel arrays this adapter reads are checked.
function parseSubmissions(body: string, label: string): EdgarSubmissions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`${label}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.filings) || !isRecord(parsed.filings.recent)) {
    throw new Error(`${label}: missing filings.recent`);
  }

  const recent = parsed.filings.recent;
  const requiredArrays: Array<keyof EdgarSubmissionsRecent> = [
    "form",
    "filingDate",
    "reportDate",
    "accessionNumber",
    "primaryDocument",
  ];
  for (const key of requiredArrays) {
    if (!isStringArray(recent[key])) {
      throw new Error(`${label}: filings.recent.${key} is missing or not an array of strings`);
    }
  }

  // Fix round 1 (Important 1): the five arrays are documented as parallel --
  // index i of one describes the same filing as index i of every other --
  // but nothing in the payload actually guarantees they're the same length.
  // A ragged payload used to zip by form.length and silently back-fill
  // missing entries with "" (an empty accession/document in the built URL,
  // an empty filing date falling back to deps.now() so the item looks
  // brand-new on every run and `since` can never filter it out again).
  // Rejecting here turns that into a per-source error result instead of a
  // garbage item nobody notices.
  const expectedLength = (recent.form as string[]).length;
  for (const key of requiredArrays) {
    const length = (recent[key] as string[]).length;
    if (length !== expectedLength) {
      throw new Error(
        `${label}: filings.recent arrays have mismatched lengths (form has ${expectedLength}, ${key} has ${length})`,
      );
    }
  }

  return {
    recent: {
      form: recent.form as string[],
      filingDate: recent.filingDate as string[],
      reportDate: recent.reportDate as string[],
      accessionNumber: recent.accessionNumber as string[],
      primaryDocument: recent.primaryDocument as string[],
    },
  };
}

// https://data.sec.gov/submissions/CIK##########.json -- the CIK zero-padded
// to ten digits. Exported so callers (and the CLI) can build the same URL
// this adapter fetches without duplicating the padding rule.
export function edgarSubmissionsUrl(cik: string): string {
  const padded = cik.padStart(10, "0");
  return `https://data.sec.gov/submissions/CIK${padded}.json`;
}

// Fix round 1 (Minor): filingUrl used to build cikNoZeros via
// String(Number(cik)) unconditionally -- a malformed CIK (empty string,
// something with letters) turns Number(cik) into NaN, and String(NaN) is
// the literal string "NaN", which would then be silently embedded in every
// filing URL built for that entity. Checked once, before any URL is built
// or any request is made, so a bad CIK fails fast as a clear per-source
// error instead of producing a URL that looks plausible but 404s.
function assertValidCik(cik: string): void {
  if (!/^\d+$/.test(cik)) {
    throw new Error(`invalid CIK "${cik}": expected a string of digits`);
  }
}

// Builds a filing's document URL:
// https://www.sec.gov/Archives/edgar/data/{cik-no-zeros}/{accession-no-dashes}/{primaryDocument}
function filingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const cikNoZeros = String(Number(cik));
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionNoDashes}/${primaryDocument}`;
}

// Fetches an entity's EDGAR submissions, filters to forms of interest
// (8-K/10-Q/10-K/6-K/20-F -- everything else, e.g. SC 13G/A ownership
// filings or 424B5 prospectus supplements, is noise for a watchlist), and
// returns one RawItem per filing not older than `since` (inclusive of its
// own instant, same convention as rssAdapter/newsAdapter -- filingDate is a
// bare day, so an exclusive cutoff lost every other filing of the day a
// watermark landed on; C2). Never throws synchronously for a
// per-feed problem (a non-200, a malformed payload, a timeout): every
// failure mode instead rejects the returned promise with a descriptive
// Error, exactly like fetchBody in watchlist-sources.ts, so the orchestrator
// can catch it per source without the whole nightly run aborting.
export function edgarAdapter(
  deps: AdapterDeps,
): (cik: string, entity: Entity, since: string | null) => Promise<RawItem[]> {
  return async (cik, entity, since) => {
    assertValidCik(cik);
    const label = `EDGAR submissions for "${entity.name}"`;
    const url = edgarSubmissionsUrl(cik);
    const body = await fetchBody(deps, url, label, EDGAR_USER_AGENT);
    const submissions = parseSubmissions(body, label);
    const { form, filingDate, reportDate, accessionNumber, primaryDocument } = submissions.recent;

    const items: RawItem[] = [];
    const count = form.length;
    for (let i = 0; i < count; i++) {
      const formType = form[i];
      if (!FORMS_OF_INTEREST.has(formType)) continue;

      const filedOn = filingDate[i] ?? "";
      const reportedOn = reportDate[i] ?? "";
      const publishedAt = filedOn.length > 0 ? new Date(filedOn).toISOString() : deps.now().toISOString();
      if (since !== null && publishedAt < since) continue;

      const docUrl = filingUrl(cik, accessionNumber[i] ?? "", primaryDocument[i] ?? "");
      // The filing's title is form + reportDate (falling back to the filing
      // date when a form carries no report date of its own, e.g. some
      // ownership filings).
      const title = `${formType} ${reportedOn.length > 0 ? reportedOn : filedOn}`.trim();
      const filingBody =
        `${formType} filed by ${entity.name} on ${filedOn}` +
        (reportedOn.length > 0 ? ` (report date ${reportedOn})` : "") +
        `. Document: ${docUrl}`;

      items.push({
        title,
        url: docUrl,
        publishedAt,
        body: filingBody,
        sourceKind: "edgar",
        sourceName: entity.name,
        titleKey: titleKey(title),
      });
    }

    return items;
  };
}

// ---- IR page adapter --------------------------------------------------------

// Fix round 1 (Important 3, R16): irPageAdapter used to return a bare
// RawItem[], so "zero items" was ambiguous between "checked the page,
// nothing new since last run" and "this page's markup isn't one this
// heuristic understands, so no date was ever recognized". linksScanned
// (anchors with a resolvable href and non-empty text -- i.e. plausible
// content links, not nav chrome) and datedLinks (of those, how many had a
// recognizable nearby date) let Task 7's orchestrator tell the two apart:
// linksScanned > 0 && datedLinks === 0 is a markup/coverage anomaly worth
// flagging; datedLinks > 0 && items.length === 0 (because `since` filtered
// everything, or the cap did) is just "nothing new".
export interface IrPageResult {
  items: RawItem[];
  linksScanned: number;
  datedLinks: number;
}

// Not a general HTML parser (same philosophy as parseFeed in
// watchlist-sources.ts): IR "reports & results" pages vary wildly in
// markup, so this looks for <a> elements whose *enclosing block* (the
// nearest surrounding li/tr/div/dd/article) also contains a recognizable
// date, and treats that as "a dated link". A link with no date anywhere in
// its enclosing block is dropped, per the brief. This is a heuristic, not a
// guarantee: a real vendor page with unusual markup (dates in a sibling
// column outside any shared block, or a block type not in BLOCK_TAGS) can
// still miss items. Capped at 20 links per page so a large results archive
// can't blow up a single ingest call.
const BLOCK_TAGS = ["li", "tr", "div", "dd", "article"] as const;
const MAX_IR_LINKS = 20;

const MONTH_NAMES =
  "January|February|March|April|May|June|July|August|September|October|November|December";
// Recognizes "Month D, YYYY", "D Month YYYY" and ISO "YYYY-MM-DD" -- the
// three date shapes actually seen on pharma IR pages.
const DATE_PATTERN = new RegExp(
  `\\b(?:${MONTH_NAMES})\\s+\\d{1,2},?\\s+\\d{4}\\b|\\b\\d{1,2}\\s+(?:${MONTH_NAMES})\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`,
  "i",
);

// Finds the tightest block (of BLOCK_TAGS) enclosing [anchorStart, anchorEnd)
// by taking, across all block tag types, the closest preceding open tag and
// the closest following close tag. Falls back to the whole document when no
// enclosing block tag is found at all.
function findEnclosingBlock(html: string, anchorStart: number, anchorEnd: number): { start: number; end: number } {
  let start = 0;
  let end = html.length;

  for (const tag of BLOCK_TAGS) {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = openRe.exec(html)) !== null) {
      if (match.index > anchorStart) break;
      const openEnd = match.index + match[0].length;
      if (openEnd > start) start = openEnd;
    }

    const closeRe = new RegExp(`<\\/${tag}>`, "i");
    const tail = html.slice(anchorEnd);
    const closeMatch = tail.match(closeRe);
    if (closeMatch !== null && closeMatch.index !== undefined) {
      const absoluteIndex = anchorEnd + closeMatch.index;
      if (absoluteIndex < end) end = absoluteIndex;
    }
  }

  return { start, end };
}

function stripTagsAndDecode(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNearbyDate(blockText: string): string | undefined {
  const match = blockText.match(DATE_PATTERN);
  if (match === null) return undefined;
  const parsed = new Date(match[0]);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

// Fix round 1 (Important 4): body used to just equal the title, but Task 6's
// tagger only ever sees `RawItem.body` -- a title-only body throws away the
// enclosing block's own text (the same text findEnclosingBlock/
// extractNearbyDate already extracted to find the date), which is real
// context (surrounding blurb, date, sometimes a document type) an IR page
// row usually carries. Falls back to the title alone when the block yields
// nothing beyond the anchor itself, and caps at MAX_ITEM_BODY_LENGTH like
// parseFeed's own body extraction (R11) does for feed items.
function buildIrItemBody(title: string, blockText: string): string {
  const combined = blockText.length > 0 ? `${title} ${blockText}`.replace(/\s+/g, " ").trim() : title;
  return combined.length > MAX_ITEM_BODY_LENGTH ? combined.slice(0, MAX_ITEM_BODY_LENGTH) : combined;
}

// Resolves an href against the page's own URL. Returns undefined for an
// empty/missing href or one the URL constructor can't resolve (e.g. a
// "javascript:" pseudo-link), rather than throwing.
function resolveHref(href: string | undefined, pageUrl: string): string | undefined {
  if (href === undefined || href.trim().length === 0) return undefined;
  if (/^(javascript|mailto):/i.test(href.trim())) return undefined;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return undefined;
  }
}

const ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

// Fetches an IR results page and extracts dated links: title = the anchor's
// own text, url = its href resolved against the page URL, publishedAt = the
// nearest date found in the anchor's enclosing block, body = title plus that
// block's own text. Undated links are dropped. `since` is inclusive of its
// own instant, matching rssAdapter/newsAdapter -- a parsed IR date is a bare
// day, so an exclusive cutoff lost every other item of the day a watermark
// landed on (C2). Uses the general feed User-Agent
// (deps.userAgent) -- unlike EDGAR, an IR page is an ordinary corporate web
// page with no special User-Agent requirement.
//
// Fix round 1 (Important 3, R16): scanning no longer stops the instant 20
// items have been collected -- it keeps examining every anchor on the page
// so linksScanned/datedLinks reflect the whole page, and only the resulting
// `items` list is capped at MAX_IR_LINKS. A page with, say, 200 real dated
// links now correctly reports datedLinks: 200 with items capped at 20,
// rather than silently under-counting because scanning quit early.
export function irPageAdapter(
  deps: AdapterDeps,
): (url: string, entity: Entity, since: string | null) => Promise<IrPageResult> {
  return async (url, entity, since) => {
    const label = `IR page for "${entity.name}"`;
    const html = await fetchBody(deps, url, label);

    const items: RawItem[] = [];
    let linksScanned = 0;
    let datedLinks = 0;
    let match: RegExpExecArray | null;
    ANCHOR_PATTERN.lastIndex = 0;
    while ((match = ANCHOR_PATTERN.exec(html)) !== null) {
      const attrs = match[1];
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
      const resolvedUrl = resolveHref(hrefMatch?.[1], url);
      if (resolvedUrl === undefined) continue;

      const title = stripTagsAndDecode(match[2]);
      if (title.length === 0) continue;

      // A plausible content link: real href, non-empty text. Counted here,
      // before we even know whether it carries a date.
      linksScanned++;

      const anchorStart = match.index;
      const anchorEnd = match.index + match[0].length;
      const { start, end } = findEnclosingBlock(html, anchorStart, anchorEnd);
      const blockText = stripTagsAndDecode(html.slice(start, end));
      const publishedAt = extractNearbyDate(blockText);
      if (publishedAt === undefined) continue;

      datedLinks++;

      if (since !== null && publishedAt < since) continue;
      if (items.length >= MAX_IR_LINKS) continue;

      items.push({
        title,
        url: resolvedUrl,
        publishedAt,
        body: buildIrItemBody(title, blockText),
        sourceKind: "ir_page",
        sourceName: entity.name,
        titleKey: titleKey(title),
      });
    }

    return { items, linksScanned, datedLinks };
  };
}
