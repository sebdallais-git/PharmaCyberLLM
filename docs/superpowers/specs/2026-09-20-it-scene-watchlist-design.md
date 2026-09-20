# IT Scene Watchlist: Customers, Competitors and Vendors

## Overview

PharmaLLM today watches topics: `news-agent.ts` runs ~40 fixed search strings through Google News
RSS, summarises each hit with the local model and ingests it into ChromaDB and Neo4j. That answers
"what is happening in pharma cyber", and nothing else.

This design broadens the system to watch **entities**: three customers (Roche, Novartis, Sandoz),
each against a named peer set (~33 unique pharma entities once the overlapping sets are merged), plus
the IT vendor scene across ten domains (~40 vendors). It adds three source
kinds beside the existing news sweep (company/vendor RSS, regulatory filings, IR-published results
material), a structured item store that makes comparison and period roll-ups possible, and
scheduled digests that Hermes mails out weekly, monthly and quarterly.

Cyber-in-pharma is not replaced. It becomes one domain of the new structure, and the existing
corpus stays searchable.

## Principles this design rests on

- **Everything local.** Fetching data is the only part allowed to touch the internet; summarising,
  tagging, embedding, digest writing and storage all run on the Mac. This holds even where a cloud
  classifier would be faster, because the corpus is named-customer intelligence.
- **Selection is deterministic, prose is generated.** What goes into a digest is decided by SQL over
  the item store; the local model only writes about the items it is handed. Every line traces to a
  stored item with a URL.
- **Fetch legally.** RSS, EDGAR's public API and material a company publishes itself are in scope.
  Transcript sites that forbid scraping are not, whatever the value of their content.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Additive: pharma-cyber becomes `domain: cyber`; the existing corpus stays indexed |
| Entities | 3 customers with 14–15 named peers each; peer sets overlap, giving ~33 unique pharma entities, plus ~40 IT vendors across 10 domains |
| Domains | cyber, ai, cloud, infrastructure, rnd_it, mfg_it, sap, data, storage, backup |
| Signals | it_move, financial, cyber, corporate |
| Sources | `rss` (company/vendor/IR), `edgar` (US filers), `ir_page` (self-published results material), `news` (existing Google News sweep, re-pointed) |
| Config | `config/watchlist.yaml`, committed; entity ids are the closed vocabulary for tagging |
| Store | SQLite (`data/watchlist.db`, `better-sqlite3`) beside ChromaDB; items also embedded with entity/domain/signal/date metadata |
| Tagging | One local-model call per deduped item returning strict JSON, restricted to known ids |
| Unmatched items | Kept, tagged by domain only — the "learn the whole scene" case |
| Digest | One combined document per period: exec summary, per customer with peer comparison, vendor scene, sources |
| Digest build | App builds it (`build_digest(period)`), bounded per-section model calls |
| Delivery | Hermes cron calls the tool and mails the result through its email adapter |
| Cadence | Weekly (Mon), monthly (1st), quarterly (after quarter end) |
| Q&A | Metadata-filtered retrieval plus `search_watchlist` and `compare_entities`, exposed to the UI and Hermes |

## Watchlist configuration

`config/watchlist.yaml` is the single definition of who is watched and where their data comes from.

```yaml
customers:
  roche:
    name: Roche
    aliases: [Genentech, Roche Diagnostics, Chugai]
    feeds:
      rss: [https://www.roche.com/media/releases.rss]
      ir_page: https://www.roche.com/investors/results
    exchange: SIX          # no SEC filings — see "Source coverage" below
    peers: [novartis, pfizer, astrazeneca, msd, jnj, abbvie, sanofi, gsk, lilly, bms,
            amgen, takeda, novo-nordisk, gilead, bayer]
  novartis:
    name: Novartis
    aliases: [Sandoz]      # historical only: pre-2023 spin-off articles
    sec_cik: "0001114448"  # 20-F / 6-K filer
    peers: [roche, pfizer, astrazeneca, msd, jnj, abbvie, sanofi, gsk, lilly, bms,
            amgen, takeda, novo-nordisk, gilead, bayer]
  sandoz:
    name: Sandoz
    exchange: SIX
    peers: [teva, viatris, sun-pharma, dr-reddys, hikma, fresenius-kabi, stada, zentiva,
            celltrion, samsung-bioepis, biocon, organon, amneal, aurobindo]

vendors:
  cloud:          [aws, microsoft-azure, google-cloud, oracle]
  ai:             [nvidia, openai, anthropic, databricks]
  infrastructure: [dell, hpe, lenovo, cisco, supermicro]
  storage:        [pure-storage, netapp, vast-data]
  backup:         [rubrik, veeam, cohesity, commvault, dell-powerprotect]
  data:           [snowflake, databricks, palantir]
  sap:            [sap]
  cyber:          [crowdstrike, palo-alto, microsoft-security, zscaler, wiz]
  rnd_it:         [veeva, benchling, dotmatics, schrodinger, certara]
  mfg_it:         [siemens, rockwell, koerber, honeywell, emerson, tulip]

# The old SEARCH_TOPICS list, kept as entity-less domain-tagged queries
topics:
  # The current SEARCH_TOPICS list from news-agent.ts, moved here verbatim and split by domain:
  # its pharma-cyber strings become domain cyber, its storage/recovery vendor strings become
  # domain storage/backup. No topic string is dropped in the move.
  cyber: ["pharmaceutical cyber attack", "pharma ransomware breach", "healthcare data breach pharmaceutical"]
  storage: ["Dell PowerProtect cyber recovery ransomware"]
```

Every entity has an id (the tagging vocabulary), a display name, aliases for matching, and whichever
feeds exist for it. A peer entry is itself an entity with its own feeds, so peers are watched at the
same fidelity as customers — that is what makes comparison possible.

## Source coverage, and its one hard limit

| Adapter | Covers | Cadence | Notes |
|---|---|---|---|
| `rss` | Company media releases, vendor and analyst blogs | daily | Backbone; no API key, no ToS issue |
| `edgar` | US filers (10-K/10-Q/8-K, 20-F/6-K) | daily | Free JSON API; requires a declared User-Agent |
| `ir_page` | Results releases, presentations, transcripts a company publishes itself | weekly, daily in earnings season | Only self-published material |
| `news` | Existing Google News RSS, re-pointed per entity and per topic | daily | Broad and noisy; deduped against the rest |

**The limit:** EDGAR covers US filers only. Novartis files (20-F/6-K) and most large peers do too,
but **Roche does not file with the SEC, and Sandoz is SIX-listed only** — two of the three customers.
For them the financial signal comes from their own IR feeds and results pages, which publish the same
releases. This is a coverage asymmetry to state plainly rather than paper over: US-listed peers will
have structured filing data that Roche and Sandoz will not, and comparisons must not read that
asymmetry as a difference in the companies.

## Item store

SQLite at `data/watchlist.db`, alongside (not replacing) ChromaDB.

```
items(id, url_canonical, content_hash, source_kind, source_name, title,
      summary, signal, importance, facts_json, published_at, fetched_at)
item_entities(item_id, entity_id)         -- many-to-many: an item can name several
item_domains(item_id, domain)
item_sources(item_id, source_kind, url)   -- the same release seen via several adapters
feed_state(feed_id, last_seen_at, last_item_hash, consecutive_failures)
```

Every stored item is also embedded into ChromaDB with `entity`, `domain`, `signal` and
`published_at` metadata, so retrieval can filter instead of relying on wording.

`facts_json` holds comparable figures where an item carries them (revenue, guidance, capex, deal
size, headcount), which is what quarterly roll-ups aggregate.

## Ingestion pipeline

Per nightly run, scheduled clear of the 06:00–07:00 Hermes window:

1. **Fetch** every due feed, honouring `feed_state` watermarks. A feed that fails increments
   `consecutive_failures`; after 5 it is reported in the digest's footer rather than failing silently.
2. **Normalise** to a common item shape (title, body text, url, published date, source).
3. **Dedupe before the model** on canonical URL and content hash. The same Novartis release arriving
   via IR RSS, Google News and EDGAR is summarised once, with all three URLs recorded in
   `item_sources`. This is the main cost saving in the whole design.
4. **Classify and summarise** in one local-model call per item, returning strict JSON:
   `{summary, entities[], domains[], signal, importance, facts{}}`. Entity ids and domains are
   validated against the watchlist; anything unknown is dropped. An item with no entity keeps its
   domains and is stored `unassigned`. An unparseable response is retried once, then the item is
   stored with its title and no tags, flagged for review.
5. **Store** the row, its join rows, and the ChromaDB embedding.

**Budget:** a per-run cap (default 250 items) applied in priority order — customers, then peers, then
vendors, then topics — so a heavy news day drops vendor noise rather than overrunning into the
morning. The cap and the run's duration are recorded per run.

**Idempotency:** re-running after a crash re-reads a few items and dedupes them away. No run
deletes or rewrites a stored item.

## Digests

`build_digest(period)` assembles one document:

1. **Executive summary** — 5–8 bullets, the highest-importance items across all customers.
2. **Per customer** (Roche, Novartis, Sandoz): their moves by domain; the peer set's moves in the
   same domains; cyber and compliance; financial highlights.
3. **The IT vendor scene** — by domain, including domain-tagged items that name no customer.
4. **Sources** — every item's link.
5. **Footer** — feeds that failed, items flagged for review, counts.

Selection is SQL: items in the period, grouped, ranked by importance, capped per section (12 per
customer, 20 for the scene). Each section is one local-model call over its own items, so output
length stays inside the model's limits — the benchmark shows single answers hitting the 1024-token
cap in 10–15 of 23 runs, which is why one call per digest is not viable. Roughly 8 calls,
10–20 minutes per digest.

The quarterly digest additionally compares `facts_json` aggregates against the previous two quarters.

## Hermes integration

- Three new cron jobs (weekly Monday, monthly on the 1st, quarterly after quarter end) call
  `build_digest` through the MCP server and deliver the result by email.
- Delivery uses Hermes' email platform adapter (IMAP in, SMTP out, `EMAIL_*` credentials). Accepting
  its inbound side is a consequence of this choice: the account Hermes uses can also receive mail,
  so it should be a dedicated address, not a personal mailbox.
- The MCP server gains `build_digest`, `search_watchlist` and `compare_entities`. Per the existing
  payload rule, tool results carry summaries and metadata, never embeddings.

## Q&A

Chat retrieval filters ChromaDB by entity, domain and date when the question names them, and falls
back to plain semantic search otherwise — so pre-pivot documents stay answerable. `compare_entities`
returns a compact table (entity × domain × item counts and headline facts) for the model to reason
over rather than raw chunks.

## Phases

| Phase | Contents | Independently useful |
|---|---|---|
| 1 | watchlist config, 4 adapters, store, tagging, nightly ingest | Yes: data accumulates, filtered Q&A works |
| 2 | `build_digest`, cron jobs, email delivery | Yes: digests arrive |
| 3 | `search_watchlist` / `compare_entities`, UI entity filters | Yes: ad-hoc comparisons |

Phase 1 must run for one to two weeks before Phase 2's digests are meaningful, because "what changed
this period" needs history.

## Risks and limits

- **Coverage asymmetry** between SEC filers and SIX-only companies (above). Stated in every digest
  that compares them.
- **Local capacity.** ~250 items/night at roughly 10–30 s each is 1–2 h of GPU time. If the nightly
  run starts colliding with other jobs, the cap comes down before anything moves off the machine.
- **Tagging quality.** Closed-vocabulary classification bounds the damage, but an item naming two
  customers and three domains can still be mis-weighted. The review flag and the digest footer make
  that visible instead of invisible.
- **Alias collisions.** "Sandoz" inside a Novartis historical article, "Roche" as a person's name.
  Aliases are matched case-sensitively with word boundaries, and the model sees the full text.
- **Feed rot.** IR and blog URLs change. `consecutive_failures` surfaces this in the digest footer.

## Out of scope

- Scraping transcript sites that forbid it, or any paid data feed.
- Re-tagging the existing 439 MB corpus (selective 6-month backfill only if a gap shows up).
- Per-customer separate digests, or per-customer email routing to account teams.
- Any cloud model for inference.
- Replacing Neo4j's entity graph — it keeps receiving entities as it does today.
