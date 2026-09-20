// RSS/Atom feed parsing and verification.
//
// A small, dependency-free extractor over <item>/<entry> elements -- enough
// for the feed shapes vendor newsrooms and IR pages actually publish (RSS
// 2.0 and Atom 1.0). It is not a general XML parser: no namespaces beyond
// what a plain regex tag match tolerates, no nested/embedded feeds. Task 4's
// "rss" adapter reuses parseFeed() directly rather than re-implementing it.

import type { Feed } from "./watchlist-config.js";

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

export interface CreateFetchOptions {
  userAgent?: string;
  timeoutMs?: number;
}

// Builds the default fetchImpl: global fetch with a User-Agent header (the
// CLI passes its own; callers that don't care get DEFAULT_USER_AGENT) and an
// optional abort-on-timeout. verifyFeed's fetchImpl parameter exists so
// tests never call this -- they inject a fake instead.
export function createFetch(options: CreateFetchOptions = {}): FetchLike {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs;

  return async (url, init) => {
    const controller = timeoutMs !== undefined ? new AbortController() : undefined;
    const timer = controller !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      return await fetch(url, {
        ...init,
        headers: { "User-Agent": userAgent, ...(init?.headers ?? {}) },
        signal: controller?.signal ?? init?.signal,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
// body, no dated items) comes back as { ok: false, error }.
export async function verifyFeed(feed: Feed, fetchImpl: FetchLike = createFetch()): Promise<VerifyFeedResult> {
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

  const body = await response.text();
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
