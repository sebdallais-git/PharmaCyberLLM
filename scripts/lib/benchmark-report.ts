// Turns two benchmark files into a comparison report and a blind A/B review page

import type { ChatTimings } from "../../src/services/bench-mode.js";
import type { BenchmarkFile } from "./benchmark-types.js";
import { jaccard, median, percentChange, percentile } from "./stats.js";

export interface MetricDefinition {
  key: keyof ChatTimings;
  label: string;
}

export interface MetricSummary extends MetricDefinition {
  medianA: number | null;
  p90A: number | null;
  medianB: number | null;
  p90B: number | null;
  changePct: number | null;
}

export interface ReviewItem {
  id: string;
  question: string;
  answers: [string, string];
}

export interface ReviewKey {
  id: string;
  first: string;
  second: string;
}

export const METRICS: MetricDefinition[] = [
  { key: "ttftMs", label: "TTFT (ms)" },
  { key: "decodeTokPerSec", label: "Decode (tok/s)" },
  { key: "embedMs", label: "Query embedding (ms)" },
  { key: "retrievalMs", label: "Retrieval (ms)" },
  { key: "totalMs", label: "Total (ms)" },
  { key: "promptTokens", label: "Prompt tokens" },
  { key: "completionTokens", label: "Completion tokens" },
];

export function metricValues(file: BenchmarkFile, key: keyof ChatTimings): number[] {
  return file.questions
    .flatMap((q) => q.runs)
    .flatMap((r) => (r.timings && !r.error ? [r.timings[key]] : []));
}

export function errorCount(file: BenchmarkFile): number {
  return file.questions.flatMap((q) => q.runs).filter((r) => r.error).length;
}

export function summarizeMetrics(a: BenchmarkFile, b: BenchmarkFile): MetricSummary[] {
  return METRICS.map((metric) => {
    const valuesA = metricValues(a, metric.key);
    const valuesB = metricValues(b, metric.key);
    const medianA = median(valuesA);
    const medianB = median(valuesB);
    return {
      ...metric,
      medianA,
      p90A: percentile(valuesA, 90),
      medianB,
      p90B: percentile(valuesB, 90),
      changePct: medianA !== null && medianB !== null ? percentChange(medianA, medianB) : null,
    };
  });
}

export function meanRetrievalOverlap(a: BenchmarkFile, b: BenchmarkFile): number | null {
  const byId = new Map(b.questions.map((q) => [q.id, q]));
  const overlaps = a.questions.flatMap((q) => {
    const firstA = q.runs.find((r) => !r.error);
    const firstB = byId.get(q.id)?.runs.find((r) => !r.error);
    return firstA && firstB ? [jaccard(firstA.chunkIds, firstB.chunkIds)] : [];
  });
  return overlaps.length === 0 ? null : overlaps.reduce((sum, v) => sum + v, 0) / overlaps.length;
}

export function orderByStack(x: BenchmarkFile, y: BenchmarkFile): [BenchmarkFile, BenchmarkFile] {
  return y.stack === "ollama" && x.stack !== "ollama" ? [y, x] : [x, y];
}

function formatNumber(value: number | null): string {
  if (value === null) return "–";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatChange(value: number | null): string {
  if (value === null) return "–";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function buildMarkdownReport(a: BenchmarkFile, b: BenchmarkFile): string {
  const lines: string[] = [
    `# Benchmark: ${a.stack} vs ${b.stack}`,
    "",
    `- ${a.stack}: ${a.environment.chatModel} + ${a.environment.embeddingModel} (${a.environment.stackVersion}), ${a.startedAt}`,
    `- ${b.stack}: ${b.environment.chatModel} + ${b.environment.embeddingModel} (${b.environment.stackVersion}), ${b.startedAt}`,
    `- Machine: ${a.environment.chip}, macOS ${a.environment.macos}; ${a.runsPerQuestion} runs per question`,
    "",
    `| Metric | ${a.stack} median | ${a.stack} p90 | ${b.stack} median | ${b.stack} p90 | ${b.stack} vs ${a.stack} |`,
    "|---|---|---|---|---|---|",
  ];

  for (const m of summarizeMetrics(a, b)) {
    lines.push(`| ${m.label} | ${formatNumber(m.medianA)} | ${formatNumber(m.p90A)} | ${formatNumber(m.medianB)} | ${formatNumber(m.p90B)} | ${formatChange(m.changePct)} |`);
  }

  const overlap = meanRetrievalOverlap(a, b);
  lines.push(
    "",
    `| Peak stack process memory (MB) | ${a.memoryPeak.processMb} | ${b.memoryPeak.processMb} |`,
    `| Peak system used memory (MB) | ${a.memoryPeak.systemUsedMb} | ${b.memoryPeak.systemUsedMb} |`,
    "",
    `Failed runs: ${a.stack} ${errorCount(a)}, ${b.stack} ${errorCount(b)}`,
    "",
    `Retrieval overlap (mean Jaccard of retrieved chunks, first run per question): ${overlap === null ? "–" : overlap.toFixed(2)}`,
    "",
    "Notes: TTFT is measured from the model request, after retrieval. Process memory may undercount GPU buffers on Apple Silicon; compare system used memory as well.",
  );

  return lines.join("\n");
}

export function buildReview(
  a: BenchmarkFile,
  b: BenchmarkFile,
  random: () => number = Math.random
): { items: ReviewItem[]; key: ReviewKey[] } {
  const byId = new Map(b.questions.map((q) => [q.id, q]));
  const items: ReviewItem[] = [];
  const key: ReviewKey[] = [];

  for (const q of a.questions) {
    const answerA = q.runs.find((r) => !r.error)?.answer;
    const answerB = byId.get(q.id)?.runs.find((r) => !r.error)?.answer;
    if (answerA === undefined || answerB === undefined) continue;

    const swap = random() < 0.5;
    items.push({ id: q.id, question: q.question, answers: swap ? [answerB, answerA] : [answerA, answerB] });
    key.push({ id: q.id, first: swap ? b.stack : a.stack, second: swap ? a.stack : b.stack });
  }

  return { items, key };
}

// Embed JSON in a <script> without letting the data close the tag
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildReviewHtml(items: ReviewItem[], key: ReviewKey[], storageId: string): string {
  // The key is base64-encoded so stack names don't appear in the page source before reveal
  const encodedKey = Buffer.from(JSON.stringify(key)).toString("base64");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Blind A/B review</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0 auto; max-width: 1200px; padding: 24px 16px; background: #f7f7f5; color: #222; }
  .item { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .answers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 800px) { .answers { grid-template-columns: 1fr; } }
  .answer { white-space: pre-wrap; background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 12px; font-size: 14px; line-height: 1.45; }
  .choices button { margin: 10px 8px 0 0; padding: 6px 12px; border-radius: 6px; border: 1px solid #bbb; background: #fff; cursor: pointer; }
  .choices button.selected { background: #2d6cdf; color: #fff; border-color: #2d6cdf; }
  #reveal { padding: 10px 18px; font-size: 15px; }
  #results { margin-top: 16px; font-size: 15px; }
</style>
</head>
<body>
<h1>Blind A/B review</h1>
<p>For each question, pick the better answer or a tie. Stacks are revealed once every question is rated.</p>
<div id="items"></div>
<button id="reveal" disabled>Reveal results</button>
<div id="results"></div>
<script>
const ITEMS = ${scriptJson(items)};
const KEY = JSON.parse(atob("${encodedKey}"));
const STORAGE = "${storageId}";
let choices = {};
try { choices = JSON.parse(localStorage.getItem(STORAGE) || "{}"); } catch (e) { choices = {}; }

function save() {
  try { localStorage.setItem(STORAGE, JSON.stringify(choices)); } catch (e) { /* storage unavailable */ }
  document.getElementById("reveal").disabled = ITEMS.some(function (item) { return !choices[item.id]; });
}

function render() {
  const container = document.getElementById("items");
  ITEMS.forEach(function (item, index) {
    const box = document.createElement("div"); box.className = "item";
    const title = document.createElement("h3"); title.textContent = (index + 1) + ". " + item.question; box.appendChild(title);
    const answers = document.createElement("div"); answers.className = "answers";
    item.answers.forEach(function (text, i) {
      const answer = document.createElement("div"); answer.className = "answer";
      const label = document.createElement("strong"); label.textContent = "Answer " + (i + 1) + "\\n\\n";
      answer.appendChild(label); answer.appendChild(document.createTextNode(text));
      answers.appendChild(answer);
    });
    box.appendChild(answers);
    const buttons = document.createElement("div"); buttons.className = "choices";
    [["first", "Answer 1 is better"], ["tie", "Tie"], ["second", "Answer 2 is better"]].forEach(function (option) {
      const button = document.createElement("button");
      button.textContent = option[1];
      if (choices[item.id] === option[0]) button.className = "selected";
      button.addEventListener("click", function () {
        choices[item.id] = option[0];
        Array.from(buttons.children).forEach(function (b) { b.className = ""; });
        button.className = "selected";
        save();
      });
      buttons.appendChild(button);
    });
    box.appendChild(buttons);
    container.appendChild(box);
  });
  save();
}

document.getElementById("reveal").addEventListener("click", function () {
  const tally = { tie: 0 };
  const lines = [];
  KEY.forEach(function (k) {
    const choice = choices[k.id];
    const winner = choice === "tie" ? "tie" : choice === "first" ? k.first : k.second;
    tally[winner] = (tally[winner] || 0) + 1;
    lines.push(k.id + ": answer 1 = " + k.first + ", answer 2 = " + k.second + " -> " + winner);
  });
  const results = document.getElementById("results");
  results.textContent = "";
  const summary = document.createElement("p");
  summary.textContent = Object.keys(tally).map(function (name) { return name + ": " + tally[name]; }).join(" | ");
  const detail = document.createElement("pre"); detail.textContent = lines.join("\\n");
  results.appendChild(summary); results.appendChild(detail);
});

render();
</script>
</body>
</html>
`;
}
