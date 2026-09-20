// EDGAR (SEC full-text/submissions API) and IR-page adapters.
//
// Two very different sources, kept in one module because both feed the same
// "a filing/report just appeared" signal that rss/newsAdapter (Task 4) cover
// for press releases: edgarAdapter reads a structured JSON API, irPageAdapter
// scrapes an unstructured investor-relations results page. Shared helpers
// (canonicalUrl, contentHash, titleKey, the fetch/timeout machinery) live in
// watchlist-sources.ts and are imported, not re-implemented.

import type { Entity } from "./watchlist-config.js";
import { DEFAULT_ADAPTER_TIMEOUT_MS, titleKey, type AdapterDeps, type FetchLike, type RawItem } from "./watchlist-sources.js";

// ---- shared self-armed-timeout fetch ---------------------------------------

// Mirrors watchlist-sources.ts's fetchBody (R12): arms its own
// AbortController + DEFAULT_ADAPTER_TIMEOUT_MS via init.signal, cleared on
// every exit path, so the deadline holds regardless of the injected
// fetchImpl. Not exported from watchlist-sources.ts, so mirrored here rather
// than duplicated blindly -- the two copies differ only in which
// User-Agent header the caller supplies (EDGAR's is stricter than the feed
// default; see EDGAR_USER_AGENT below).
async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  userAgent: string,
  label: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_ADAPTER_TIMEOUT_MS);
  timer.unref?.();

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(url, { headers: { "User-Agent": userAgent }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    clearTimeout(timer);
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }

  try {
    return await response.text();
  } catch (err) {
    throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

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
// returns one RawItem per filing newer than `since` (exclusive, same
// convention as rssAdapter/newsAdapter). Never throws synchronously for a
// per-feed problem (a non-200, a malformed payload, a timeout): every
// failure mode instead rejects the returned promise with a descriptive
// Error, exactly like fetchBody in watchlist-sources.ts, so the orchestrator
// can catch it per source without the whole nightly run aborting.
export function edgarAdapter(
  deps: AdapterDeps,
): (cik: string, entity: Entity, since: string | null) => Promise<RawItem[]> {
  return async (cik, entity, since) => {
    const label = `EDGAR submissions for "${entity.name}"`;
    const url = edgarSubmissionsUrl(cik);
    const body = await fetchWithTimeout(deps.fetchImpl, url, EDGAR_USER_AGENT, label);
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
      if (since !== null && publishedAt <= since) continue;

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
// nearest date found in the anchor's enclosing block. Undated links are
// dropped. `since` is exclusive, matching rssAdapter/newsAdapter. Uses the
// general feed User-Agent (deps.userAgent) -- unlike EDGAR, an IR page is an
// ordinary corporate web page with no special User-Agent requirement.
export function irPageAdapter(
  deps: AdapterDeps,
): (url: string, entity: Entity, since: string | null) => Promise<RawItem[]> {
  return async (url, entity, since) => {
    const label = `IR page for "${entity.name}"`;
    const html = await fetchWithTimeout(deps.fetchImpl, url, deps.userAgent, label);

    const items: RawItem[] = [];
    let match: RegExpExecArray | null;
    ANCHOR_PATTERN.lastIndex = 0;
    while ((match = ANCHOR_PATTERN.exec(html)) !== null) {
      if (items.length >= MAX_IR_LINKS) break;

      const attrs = match[1];
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
      const resolvedUrl = resolveHref(hrefMatch?.[1], url);
      if (resolvedUrl === undefined) continue;

      const title = stripTagsAndDecode(match[2]);
      if (title.length === 0) continue;

      const anchorStart = match.index;
      const anchorEnd = match.index + match[0].length;
      const { start, end } = findEnclosingBlock(html, anchorStart, anchorEnd);
      const blockText = stripTagsAndDecode(html.slice(start, end));
      const publishedAt = extractNearbyDate(blockText);
      if (publishedAt === undefined) continue;

      if (since !== null && publishedAt <= since) continue;

      items.push({
        title,
        url: resolvedUrl,
        publishedAt,
        body: title,
        sourceKind: "ir_page",
        sourceName: entity.name,
        titleKey: titleKey(title),
      });
    }

    return items;
  };
}
