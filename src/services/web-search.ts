// Web search service using Google News RSS (no API key needed)

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  date: string;
}

export async function searchWeb(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });

  const response = await fetch(
    `https://news.google.com/rss/search?${params}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    }
  );

  if (!response.ok) {
    console.error(`Web search failed: ${response.status}`);
    return [];
  }

  const xml = await response.text();
  const results: SearchResult[] = [];

  // Parse RSS XML items
  const items = xml.split("<item>");
  for (let i = 1; i < items.length && results.length < maxResults; i++) {
    const item = items[i];

    const title = extractTag(item, "title");
    const link = extractTag(item, "link");
    const pubDate = extractTag(item, "pubDate");
    const description = extractTag(item, "description");

    // Extract source and snippet from description HTML
    const snippet = description
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .trim();

    if (title) {
      results.push({
        title: decodeEntities(title),
        snippet: snippet || title,
        url: link,
        date: pubDate ? formatDate(pubDate) : "",
      });
    }
  }

  return results;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(regex);
  if (match) return match[1].trim();

  // Handle self-closing or content after tag (like <link>url\n)
  const simpleRegex = new RegExp(`<${tag}>([^<]*)`);
  const simpleMatch = xml.match(simpleRegex);
  return simpleMatch ? simpleMatch[1].trim() : "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export type { SearchResult };
