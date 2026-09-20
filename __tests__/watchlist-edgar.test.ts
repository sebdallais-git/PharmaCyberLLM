import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  edgarAdapter,
  edgarSubmissionsUrl,
  irPageAdapter,
} from "../src/services/watchlist-edgar.js";
import { DEFAULT_ADAPTER_TIMEOUT_MS, type AdapterDeps, type FetchLike } from "../src/services/watchlist-sources.js";
import type { Entity } from "../src/services/watchlist-config.js";

const FIXED_NOW = new Date("2026-09-20T12:00:00.000Z");

// Never fetches a real EDGAR endpoint or IR page: every test injects this.
function fakeFetch(status: number, body: string): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
}

function testDeps(fetchImpl: FetchLike): AdapterDeps {
  return { fetchImpl, now: () => FIXED_NOW, userAgent: "PharmaLLM-Test/1.0" };
}

const NOVARTIS: Entity = {
  id: "novartis",
  name: "Novartis",
  kind: "customer",
  aliases: [],
  domains: [],
  peers: [],
  feeds: [],
};

// A trimmed but realistic shape of https://data.sec.gov/submissions/CIK##########.json --
// only the "filings.recent" parallel arrays this adapter reads, mixing forms
// of interest with forms that must be dropped, plus one filing older than
// the "since" cutoff used below.
const SUBMISSIONS_FIXTURE = JSON.stringify({
  cik: "1114448",
  name: "Novartis AG",
  filings: {
    recent: {
      form: ["6-K", "SC 13G/A", "8-K", "424B5", "6-K"],
      filingDate: ["2026-09-16", "2026-09-10", "2026-08-01", "2026-07-20", "2026-01-05"],
      reportDate: ["2026-06-30", "", "2026-08-01", "", "2025-12-31"],
      accessionNumber: [
        "0001114448-26-000123",
        "0001114448-26-000120",
        "0001114448-26-000099",
        "0001114448-26-000090",
        "0001114448-26-000010",
      ],
      primaryDocument: ["nvs-20260916.htm", "nvs-sc13g.htm", "nvs-20260801-8k.htm", "nvs-424b5.htm", "nvs-old-6k.htm"],
    },
    files: [],
  },
});

const SINCE_CUTOFF = "2026-02-01T00:00:00.000Z";

describe("edgarSubmissionsUrl", () => {
  it("pads a bare CIK to ten digits", () => {
    expect(edgarSubmissionsUrl("1114448")).toBe("https://data.sec.gov/submissions/CIK0001114448.json");
  });

  it("leaves an already zero-padded CIK alone", () => {
    expect(edgarSubmissionsUrl("0001114448")).toBe("https://data.sec.gov/submissions/CIK0001114448.json");
  });
});

describe("edgarAdapter", () => {
  it("keeps only forms of interest (8-K, 10-Q, 10-K, 6-K, 20-F)", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(200, SUBMISSIONS_FIXTURE)));
    const items = await adapter("1114448", NOVARTIS, null);

    const forms = items.map((item) => item.sourceKind);
    expect(forms.every((kind) => kind === "edgar")).toBe(true);
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.title)).toEqual([
      "6-K 2026-06-30",
      "8-K 2026-08-01",
      "6-K 2025-12-31",
    ]);
  });

  it("drops filings older than since", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(200, SUBMISSIONS_FIXTURE)));
    const items = await adapter("1114448", NOVARTIS, SINCE_CUTOFF);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.title)).toEqual(["6-K 2026-06-30", "8-K 2026-08-01"]);
  });

  it("builds the filing URL from cik (no leading zeros), accession (no dashes) and primaryDocument", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(200, SUBMISSIONS_FIXTURE)));
    const items = await adapter("0001114448", NOVARTIS, null);

    expect(items[0].url).toBe(
      "https://www.sec.gov/Archives/edgar/data/1114448/000111444826000123/nvs-20260916.htm",
    );
  });

  it("builds a body carrying form, report date, filing date, company name and the document url", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(200, SUBMISSIONS_FIXTURE)));
    const items = await adapter("1114448", NOVARTIS, null);

    const sixK = items[0];
    expect(sixK.body).toContain("6-K");
    expect(sixK.body).toContain("2026-06-30");
    expect(sixK.body).toContain("2026-09-16");
    expect(sixK.body).toContain("Novartis");
    expect(sixK.body).toContain(sixK.url);
  });

  it("sets titleKey from the built title, matching the shared titleKey rules", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(200, SUBMISSIONS_FIXTURE)));
    const items = await adapter("1114448", NOVARTIS, null);

    expect(items[0].titleKey).toBe("6k 20260630");
  });

  it("produces an error naming the status on a 403 (EDGAR's response to a missing User-Agent)", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(403, "Forbidden")));

    await expect(adapter("1114448", NOVARTIS, null)).rejects.toThrow(/403/);
  });

  it("rejects with a descriptive error on a malformed (non-EDGAR-shaped) payload", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(200, JSON.stringify({ unexpected: true }))));

    await expect(adapter("1114448", NOVARTIS, null)).rejects.toThrow();
  });

  it("rejects with a descriptive error on non-JSON body", async () => {
    const adapter = edgarAdapter(testDeps(fakeFetch(200, "<html>not json</html>")));

    await expect(adapter("1114448", NOVARTIS, null)).rejects.toThrow();
  });

  it("sends the EDGAR-specific declared User-Agent, not the general feed one", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = init?.headers;
      return { ok: true, status: 200, text: async () => SUBMISSIONS_FIXTURE };
    };
    const adapter = edgarAdapter(testDeps(fetchImpl));
    await adapter("1114448", NOVARTIS, null);

    expect(seenHeaders?.["User-Agent"]).toBe("PharmaLLM/1.0 (sebdallais@gmail.com)");
  });

  it("fetches the submissions URL for the given CIK", async () => {
    let seenUrl: string | undefined;
    const fetchImpl: FetchLike = async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, text: async () => SUBMISSIONS_FIXTURE };
    };
    const adapter = edgarAdapter(testDeps(fetchImpl));
    await adapter("1114448", NOVARTIS, null);

    expect(seenUrl).toBe("https://data.sec.gov/submissions/CIK0001114448.json");
  });
});

describe("edgarAdapter self-imposed timeout (R12)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("bounds a hung fetch to DEFAULT_ADAPTER_TIMEOUT_MS instead of hanging forever", async () => {
    jest.useFakeTimers();
    const hungFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    const adapter = edgarAdapter(testDeps(hungFetch));

    const resultPromise = adapter("1114448", NOVARTIS, null);
    const assertion = expect(resultPromise).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(DEFAULT_ADAPTER_TIMEOUT_MS);
    await assertion;
  });
});

// A trimmed fixture of the shape a pharma IR "Reports & results" page
// actually publishes: a list of dated links, one undated link that must be
// dropped, and a relative href that must resolve against the page's own URL.
const IR_PAGE_URL = "https://www.example-pharma.com/investors/reports";
const IR_PAGE_HTML = `<!DOCTYPE html>
<html>
<body>
  <ul class="press-releases">
    <li>
      <span class="date">September 16, 2026</span>
      <a href="/investors/reports/q3-2026-results.pdf">Q3 2026 Results</a>
    </li>
    <li>
      <span class="date">August 3, 2026</span>
      <a href="https://example-pharma.com/investors/reports/q2-2026-results.pdf">Q2 2026 Results</a>
    </li>
    <li>
      <a href="/investors/reports/undated-flyer.pdf">Undated flyer</a>
    </li>
  </ul>
</body>
</html>`;

describe("irPageAdapter", () => {
  it("extracts dated links and resolves relative hrefs against the page URL", async () => {
    const adapter = irPageAdapter(testDeps(fakeFetch(200, IR_PAGE_HTML)));
    const items = await adapter(IR_PAGE_URL, NOVARTIS, null);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Q3 2026 Results",
      url: "https://www.example-pharma.com/investors/reports/q3-2026-results.pdf",
      sourceKind: "ir_page",
      sourceName: "Novartis",
    });
    expect(items[1]).toMatchObject({
      title: "Q2 2026 Results",
      url: "https://example-pharma.com/investors/reports/q2-2026-results.pdf",
    });
  });

  it("drops links with no nearby date", async () => {
    const adapter = irPageAdapter(testDeps(fakeFetch(200, IR_PAGE_HTML)));
    const items = await adapter(IR_PAGE_URL, NOVARTIS, null);

    expect(items.some((item) => item.title === "Undated flyer")).toBe(false);
  });

  it("drops items older than since", async () => {
    const adapter = irPageAdapter(testDeps(fakeFetch(200, IR_PAGE_HTML)));
    const items = await adapter(IR_PAGE_URL, NOVARTIS, "2026-09-01T00:00:00.000Z");

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Q3 2026 Results");
  });

  it("caps at 20 links per page", async () => {
    const manyLinks = Array.from({ length: 25 }, (_, i) => {
      const day = String((i % 27) + 1).padStart(2, "0");
      return `<li><span class="date">2026-01-${day}</span><a href="/r/${i}.pdf">Report ${i}</a></li>`;
    }).join("\n");
    const html = `<html><body><ul>${manyLinks}</ul></body></html>`;

    const adapter = irPageAdapter(testDeps(fakeFetch(200, html)));
    const items = await adapter(IR_PAGE_URL, NOVARTIS, null);

    expect(items).toHaveLength(20);
  });

  it("sends the general feed User-Agent (not the EDGAR-specific one)", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = init?.headers;
      return { ok: true, status: 200, text: async () => IR_PAGE_HTML };
    };
    const adapter = irPageAdapter(testDeps(fetchImpl));
    await adapter(IR_PAGE_URL, NOVARTIS, null);

    expect(seenHeaders?.["User-Agent"]).toBe("PharmaLLM-Test/1.0");
  });

  it("rejects on a non-200 response, naming the status", async () => {
    const adapter = irPageAdapter(testDeps(fakeFetch(503, "unavailable")));

    await expect(adapter(IR_PAGE_URL, NOVARTIS, null)).rejects.toThrow(/503/);
  });
});
