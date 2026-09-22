# Artifact export: Excel, PDF and PowerPoint

**Date:** 2026-09-22
**Status:** approved design, not yet implemented
**Goal:** the chatbot produces any artifact the user asks for, in any of three
formats, delivered where the prompt says.

## Why

The data is already structured and currently only readable through chat: the
vendor graph (60 nodes, positions with confidence and rationale), the install
base per account, 760 watchlist items, and six sourced vendor briefs. A deck or
a spreadsheet is therefore a rendering problem, not a research problem.

The app reads `.pdf`, `.docx` and `.pptx` today (`pdf-parse`, `mammoth`) and
writes none of them. No rendering library is installed.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Artifact ↔ format | Any artifact, any format | A typed artifact model, one renderer per format |
| Audience | `internal` \| `external`, **no default** | A missing audience is a 400, never a guess |
| Content | The model writes most of the document | User's choice, 2026-09-22 |
| Safety gate | **None** — treated like a chat answer | User's choice, 2026-09-22; see Risks |
| Destinations | `download` (default), `telegram`, `icloud` | Chosen per request, inferred from the prompt |
| Execution | Async job, always | A deck is ~15 minutes; no request may block on it |

## Architecture

```
POST /api/export { artifact, format, audience, destination? }  -> { jobId }
GET  /api/export/:jobId                                        -> status | url

worker:  gather    facts from graph + watchlist + briefs
      -> narrate   LLM prose (the slow step, checkpointed)
      -> render    exceljs | pdf-lib | pptxgenjs
      -> deliver   download | telegram | icloud
```

The pipeline is one path with pluggable ends. A new format is a renderer; a new
artifact is a gatherer; a new destination is a delivery adapter. None of those
touch the others.

### The artifact model

The join between gathering and rendering, and the reason any artifact can
become any format. Gatherers produce it; renderers consume it and know nothing
about vendors, accounts or segments.

```ts
interface Artifact {
  title: string;
  subtitle?: string;
  audience: "internal" | "external";
  generatedAt: string;
  sections: Section[];
  citations: Citation[];      // url + title, referenced by id from prose
}

type Section =
  | { kind: "prose";   heading: string; body: string; cites: string[] }
  | { kind: "table";   heading: string; columns: string[]; rows: string[][] }
  | { kind: "facts";   heading: string; items: { label: string; value: string }[] }
  | { kind: "chart";   heading: string; spec: VegaLiteSpec };
```

Charts render to **SVG, not PNG**: the usual PNG path needs `node-canvas` and
therefore native Cairo, which breaks on macOS upgrades. SVG is pure JS and
embeds in both PPTX and PDF.

### Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `export-artifacts.ts` | Gatherers: account brief, incumbency matrix, vendor comparison, watchlist digest | graph, watchlist store, briefs |
| `export-narrative.ts` | Fills `prose` sections from the facts | llm-client |
| `render-xlsx.ts` | Artifact -> .xlsx | exceljs |
| `render-pdf.ts` | Artifact -> .pdf | pdf-lib |
| `render-pptx.ts` | Artifact -> .pptx | pptxgenjs |
| `export-delivery.ts` | download / telegram / icloud | fs, Hermes |
| `export-jobs.ts` | Queue, status, retention | sqlite |

### Audience

`internal` renders everything: incumbents per segment, defend/displace/
greenfield, position with confidence, where a vendor is weak, competitor
strengths.

`external` strips all of it. Not a redaction pass over a rendered document --
the gatherer emits different sections, so the internal content is never in the
object a renderer sees. Incumbency, confidence and competitive framing cannot
leak through a formatting bug because they were never present.

There is no default. An export without an audience is a 400.

### Destinations

| Destination | Behaviour |
|---|---|
| `download` (default) | File served at a job URL. "Ready at this link", never a streamed 15-minute response. |
| `telegram` | Sent as a document through Hermes, which already handles attachments. |
| `icloud` | Written to `~/Documents/PharmaITChat_Artifacts/` (configurable, created on first use). |

`~/Documents` is the iCloud-synced folder on this Mac -- verified 2026-09-22,
`CloudDocs/Documents` is a symlink to it. Anything written there leaves the
machine. That is deliberate (it is how the files reach the iPad) but it is worth
stating plainly, because `config/accounts.local.yaml` is gitignored precisely
because it holds account intelligence, and an internal-audience artifact
contains that same intelligence.

## Execution and failure

The LLM step dominates: ~3.4 tok/s with a RAG-sized prompt, so a deck is
minutes, and it contends with everything else on the single MLX server. Three
consequences shape the design:

1. **Always async.** `download` means a URL that becomes ready, not a held
   connection. A synchronous export would reproduce the timeout that made chat
   look broken on 2026-09-21.
2. **Checkpointed.** Gathered facts are stored before narration, so a retry
   re-narrates without re-gathering, and a delivery failure re-delivers without
   re-rendering.
3. **A busy model is not an error.** The job waits. Only a failed generation is
   a failure, and the status names the stage that failed.

## Testing

Renderers take an artifact and produce bytes: pure, fixture-driven, no LLM and
no services. Delivery adapters take an injected filesystem and Hermes client.
Gatherers take injected stores. The narrative step is mocked everywhere except
one live smoke test.

Two cases earn their own tests because they are the ones that would hurt:
an `external` artifact must contain no incumbency, confidence or competitive
field (asserted on the artifact object, not the rendered bytes), and a request
without an `audience` must be rejected.

## Risks accepted

**No safety gate on model-written content** (user's decision, 2026-09-22).
Exports carry whatever the model wrote, with a citations list, and are trusted
the way a chat answer is trusted. The known failure mode: on 2026-09-21 the
model asserted a $750M PathAI acquisition that was real only because a STAT
article happened to be in the retrieved set -- nothing verified it. An
`external` artifact goes to a customer, so a wrong figure is materially worse
there than in chat. The decision was made with that example on the table.

**Sandoz coverage is thin** -- 5 stored items, and roughly 3 IT articles per 30
days exist to collect. A Sandoz artifact will be sparse, and that is the market
rather than a fault to debug later.

## Out of scope

- **Sending email.** A separate subsystem with its own credentials, failure
  modes and security surface, designed separately. Its first question is whether
  the agent may send without a human pressing send.
- **Generated images.** Local diffusion would put a second model on a GPU that
  already returned `[metal::malloc] Resource limit exceeded` under one model.
  Charts cover what account work actually needs.
