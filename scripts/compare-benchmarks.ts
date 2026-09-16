// Compare two benchmark runs and build a blind A/B review page
// Usage: npx tsx scripts/compare-benchmarks.ts data/benchmarks/ollama-….json data/benchmarks/mlx-….json

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkFile } from "./lib/benchmark-types.js";
import { buildMarkdownReport, buildReview, buildReviewHtml, orderByStack } from "./lib/benchmark-report.js";

async function main(): Promise<void> {
  const [pathX, pathY] = process.argv.slice(2);
  if (!pathX || !pathY) {
    console.error("Usage: compare-benchmarks.ts <a.json> <b.json>");
    process.exit(1);
  }

  const x = JSON.parse(await readFile(pathX, "utf-8")) as BenchmarkFile;
  const y = JSON.parse(await readFile(pathY, "utf-8")) as BenchmarkFile;
  const [a, b] = orderByStack(x, y);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(process.cwd(), "data", "benchmarks");

  const report = buildMarkdownReport(a, b);
  const reportPath = join(dir, `compare-${stamp}.md`);
  await writeFile(reportPath, report + "\n", "utf-8");

  const { items, key } = buildReview(a, b);
  const reviewPath = join(dir, `review-${stamp}.html`);
  await writeFile(reviewPath, buildReviewHtml(items, key, `review-${stamp}`), "utf-8");

  console.log(report);
  console.log(`\nReport: ${reportPath}\nBlind review: ${reviewPath} (open it in a browser)`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
