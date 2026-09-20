// RSS/Atom feed parsing and verification.
//
// A small, dependency-free extractor over <item>/<entry> elements -- enough
// for the feed shapes vendor newsrooms and IR pages actually publish (RSS
// 2.0 and Atom 1.0). It is not a general XML parser: no namespaces beyond
// what a plain regex tag match tolerates, no nested/embedded feeds. Task 4's
// "rss" adapter reuses parseFeed() directly rather than re-implementing it.

import { createHash } from "node:crypto";
import type { Entity, Feed } from "./watchlist-config.js";

// ---- fetch injection -------------------------------------------------------

// A fetch-shaped function, deliberately narrower than the DOM lib.fetch
// signature so a hand-rolled fake in a test satisfies it without pulling in
// a real Response object.
export interface FetchLike {
  (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; PharmaLLM/1.0; +sebdallais@gmail.com)";

// The bound verifyFeed's default fetchImpl uses when a caller doesn't supply
// its own timeoutMs (fix round 1: a bare verifyFeed(feed) used to have no
// timeout at all, since createFetch()'s default options carry no
// timeoutMs -- see verifyFeed below). Shared with scripts/watchlist.ts so
// the CLI and the library default don't drift apart as two separate "10
// seconds" literals.
export const DEFAULT_FEED_TIMEOUT_MS = 10_000;

export interface CreateFetchOptions {
  userAgent?: string;
  timeoutMs?: number;
}

// Builds the default fetchImpl: global fetch with a User-Agent header (the
// CLI passes its own; callers that don't care get DEFAULT_USER_AGENT) and an
// optional abort-on-timeout. verifyFeed's fetchImpl parameter exists so
// tests never call this -- they inject a fake instead.
//
// Fix round 1: the deadline used to only cover the fetch() call itself --
// clearTimeout ran in a finally around fetch(), i.e. the instant headers
// arrived, well before a caller ever reads the body. A host that returns
// 200 + headers and then stalls mid-body was therefore unbounded: the timer
// had already been cleared, so controller.abort() could never fire to
// interrupt a hung response.text(). Now the SAME timer/controller stays
// armed until the returned object's text() has actually been read (or the
// initial fetch() itself throws), so one deadline covers the whole
// request -- headers and body both -- since aborting the controller while a
// fetch()'s body is still being consumed aborts that read too. If the
// caller never calls text() at all (e.g. verifyFeed short-circuits on a
// non-2xx status), the timer is unref'd so it can still fire later to
// release the underlying response, but never blocks the process or a test
// run from exiting while pending.
export function createFetch(options: CreateFetchOptions = {}): FetchLike {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs;

  return async (url, init) => {
    const controller = timeoutMs !== undefined ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (controller !== undefined) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
    }

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        ...init,
        headers: { "User-Agent": userAgent, ...(init?.headers ?? {}) },
        signal: controller?.signal ?? init?.signal,
      });
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer);
      throw err;
    }

    return {
      ok: response.ok,
      status: response.status,
      async text(): Promise<string> {
        try {
          return await response.text();
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
    };
  };
}

// ---- RSS/Atom parsing -------------------------------------------------------

export interface ParsedFeedItem {
  title: string;
  link: string;
  // undefined when the item carries no date the parser recognizes
  // (neither <pubDate>, <updated> nor <published>).
  publishedAt?: string;
}

function extractBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1];
}

// Strips a CDATA wrapper, then decodes the handful of HTML entities feeds
// actually use in titles. &amp; is decoded last so a literal "&amp;amp;"
// (already-escaped ampersand) doesn't get double-unescaped.
function decodeText(raw: string): string {
  const cdataMatch = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const text = cdataMatch !== null ? cdataMatch[1] : raw;
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, "&")
    .trim();
}

// Normalizes both RFC-822 ("Tue, 15 Sep 2026 08:00:00 GMT") and ISO-8601
// dates to an ISO string. Both formats parse natively with Date(); anything
// Date() can't make sense of comes back undefined rather than "Invalid Date".
function normalizeDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = decodeText(raw);
  if (trimmed.length === 0) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

// RSS gives a plain-text <link>; Atom gives one or more self-closing
// <link href="..." rel="..."/> elements. Prefer the alternate (or unmarked,
// which defaults to alternate) Atom link over other rels like "self".
function extractLink(block: string): string {
  const atomLinkPattern = /<link\b([^>]*)\/?>/gi;
  let atomMatch: RegExpExecArray | null;
  let firstHref: string | undefined;
  while ((atomMatch = atomLinkPattern.exec(block)) !== null) {
    const attrs = atomMatch[1];
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
    if (hrefMatch === null) continue;
    if (firstHref === undefined) firstHref = hrefMatch[1];
    const relMatch = attrs.match(/rel\s*=\s*["']([^"']*)["']/i);
    if (relMatch === null || relMatch[1] === "alternate") {
      return decodeText(hrefMatch[1]);
    }
  }

  const rssMatch = block.match(/<link>([^<]*)<\/link>/i);
  if (rssMatch !== null) return decodeText(rssMatch[1]);

  return firstHref !== undefined ? decodeText(firstHref) : "";
}

// Extracts every <item> (RSS) and <entry> (Atom) element into a parsed item.
// Exported so Task 4's "rss" adapter can reuse it rather than re-implement
// the same extraction.
export function parseFeed(xml: string): ParsedFeedItem[] {
  const blocks = [...extractBlocks(xml, "item"), ...extractBlocks(xml, "entry")];

  return blocks.map((block) => {
    const rawTitle = extractTag(block, "title") ?? "";
    const rawDate = extractTag(block, "pubDate") ?? extractTag(block, "updated") ?? extractTag(block, "published");
    return {
      title: decodeText(rawTitle),
      link: extractLink(block),
      publishedAt: normalizeDate(rawDate),
    };
  });
}

// ---- feed verification -------------------------------------------------------

export interface VerifyFeedResult {
  ok: boolean;
  items: number;
  newest?: string;
  error?: string;
}

// Fetches a feed and reports whether it is usable: valid RSS/Atom, at least
// one item, and at least one item with a date the parser can normalize.
// Never throws -- every failure mode (network error, HTTP error, non-XML
// body, no dated items, a body read that times out) comes back as
// { ok: false, error }.
//
// Fix round 1: the default fetchImpl used to be createFetch() with no
// options, so timeoutMs was undefined and a bare verifyFeed(feed) could
// hang forever on an unresponsive host. DEFAULT_FEED_TIMEOUT_MS makes a
// call safe by default rather than safe only if the caller remembers to
// pass one.
export async function verifyFeed(
  feed: Feed,
  fetchImpl: FetchLike = createFetch({ timeoutMs: DEFAULT_FEED_TIMEOUT_MS }),
): Promise<VerifyFeedResult> {
  if (feed.url === undefined) {
    return { ok: false, items: 0, error: `feed kind "${feed.kind}" has no url to verify` };
  }

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(feed.url);
  } catch (err) {
    return { ok: false, items: 0, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    return { ok: false, items: 0, error: `HTTP ${response.status}` };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    // A body read that stalls past createFetch's deadline lands here (the
    // shared timer aborts it) -- treated the same as any other fetch
    // failure rather than left to reject out of verifyFeed.
    return { ok: false, items: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (!/<(rss|feed)\b/i.test(body)) {
    return { ok: false, items: 0, error: "response is not an RSS or Atom feed" };
  }

  const items = parseFeed(body);
  if (items.length === 0) {
    return { ok: false, items: 0, error: "feed has no items" };
  }

  const dated = items
    .map((item) => item.publishedAt)
    .filter((publishedAt): publishedAt is string => publishedAt !== undefined);
  if (dated.length === 0) {
    return { ok: false, items: items.length, error: "feed has no dated items" };
  }

  const newest = dated.reduce((max, current) => (current > max ? current : max), dated[0]);
  return { ok: true, items: items.length, newest };
}

// ---- rss/news adapters -----------------------------------------------------

// Timeout the nightly ingest run should apply per outbound request. Kept
// distinct from DEFAULT_FEED_TIMEOUT_MS (verify-feeds' own, shorter default)
// since a run's per-source budget is looser than an interactive verify
// command's. Adapters here receive an already-built FetchLike via
// AdapterDeps -- they don't call createFetch themselves -- so this constant
// is what the orchestrator wiring deps.fetchImpl should pass as timeoutMs,
// e.g. createFetch({ userAgent, timeoutMs: DEFAULT_ADAPTER_TIMEOUT_MS }).
export const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;

// A single ingested item before tagging/summarization (later tasks). RSS and
// Atom carry no separate description through parseFeed (Task 3 extracts only
// title/link/date), so `body` is the title itself -- there is no other text
// to reuse without writing a second parser, which the brief rules out.
export interface RawItem {
  title: string;
  url: string;
  publishedAt: string;
  body: string;
  sourceKind: Feed["kind"];
  sourceName: string;
}

export interface AdapterDeps {
  fetchImpl: FetchLike;
  // Injected clock, not Date.now(): lets tests fix "now" and lets a feed
  // item with no parseable date (see below) get a deterministic fallback
  // instead of being silently dropped.
  now(): Date;
  userAgent: string;
}

// Fetches one URL through deps.fetchImpl and returns its body, converting
// every failure mode (network/TLS error, non-2xx status) into a rejected
// Error carrying `label` and the status/message -- never the url itself,
// which may carry a tracking query string that shouldn't end up in logs.
// This still lets the run survive a per-feed failure: rejecting here makes
// rssAdapter/newsAdapter's returned promise reject, which the orchestrator
// (a later task) awaits per feed inside its own try/catch, exactly the way
// verifyFeed's caller already isolates one bad feed from the rest of a run.
async function fetchBody(deps: AdapterDeps, url: string, label: string): Promise<string> {
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await deps.fetchImpl(url, { headers: { "User-Agent": deps.userAgent } });
  } catch (err) {
    throw new Error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }
  return response.text();
}

// Shared by rssAdapter and newsAdapter: turns parsed feed items into
// RawItems, applying the since cutoff and the "no date" fallback. An item
// exactly at `since` is treated as already seen and dropped, on the
// assumption `since` is the high-water mark of the previous run.
function toRawItems(
  parsed: ParsedFeedItem[],
  sourceKind: Feed["kind"],
  sourceName: string,
  since: string | null,
  now: () => Date,
): RawItem[] {
  const items: RawItem[] = [];
  for (const item of parsed) {
    const publishedAt = item.publishedAt ?? now().toISOString();
    if (since !== null && publishedAt <= since) continue;
    items.push({
      title: item.title,
      url: item.link,
      publishedAt,
      body: item.title,
      sourceKind,
      sourceName,
    });
  }
  return items;
}

// Fetches and parses one entity's feed (rss or ir_page: both are just an XML
// URL to GET). Reuses parseFeed rather than a second parser, per the brief.
export function rssAdapter(
  deps: AdapterDeps,
): (feed: Feed, entity: Entity, since: string | null) => Promise<RawItem[]> {
  return async (feed, entity, since) => {
    if (feed.url === undefined) {
      throw new Error(`feed for "${entity.name}" (${feed.kind}) has no url`);
    }
    const body = await fetchBody(deps, feed.url, `feed for "${entity.name}" (${feed.kind})`);
    return toRawItems(parseFeed(body), feed.kind, entity.name, since, deps.now);
  };
}

// Fetches Google News' RSS search for a query -- same URL shape as
// src/services/web-search.ts's searchWeb (q/hl/gl/ceid), so the two never
// drift into fetching subtly different result sets for the same text.
export function newsAdapter(deps: AdapterDeps): (query: string, since: string | null) => Promise<RawItem[]> {
  return async (query, since) => {
    const params = new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" });
    const url = `https://news.google.com/rss/search?${params.toString()}`;
    const body = await fetchBody(deps, url, "Google News request");
    return toRawItems(parseFeed(body), "news", "Google News", since, deps.now);
  };
}

// ---- dedupe keys ------------------------------------------------------------

// Query params that only carry tracking/attribution noise, never identify
// the underlying article -- stripping them is what lets the same press
// release reached via IR RSS, Google News and EDGAR collapse to one url.
const TRACKING_PARAM_EXACT = new Set(["fbclid", "gclid"]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAM_EXACT.has(lower);
}

// Normalizes a url into the dedupe key the whole nightly run's cost depends
// on: lowercase host (the WHATWG URL parser already does this, and the
// scheme, for free), no fragment, no tracking params, a stable (sorted)
// order for whatever query params remain, and no trailing slash on a
// non-root path. Two urls that are "the same page" by these rules produce
// byte-identical output.
//
// A url the URL constructor can't parse at all is returned trimmed rather
// than thrown on -- canonicalization best-effort degrades to "as given"
// instead of aborting an ingest run over one malformed link.
export function canonicalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim();
  }

  const keptParams = [...parsed.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(keptParams).toString();

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  const host = parsed.host.toLowerCase();
  return `${parsed.protocol}//${host}${pathname}${query.length > 0 ? `?${query}` : ""}`;
}

// Hashes title+body over normalised whitespace and case so the same press
// release re-typeset with different spacing/casing across sources still
// hashes identically -- the second half of the dedupe key alongside
// canonicalUrl (a source can reuse one url for many stories, e.g. a
// paginated newsroom index, so url alone isn't enough).
export function contentHash(title: string, body: string): string {
  const normalized = `${title}\n${body}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}
