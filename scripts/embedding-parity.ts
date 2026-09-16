// Cross-stack embedding parity check. The stacks run one after the other, never together.
// Usage:
//   LLM_PROVIDER=ollama npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-ollama.json
//   LLM_PROVIDER=mlx    npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-mlx.json
//   npx tsx scripts/embedding-parity.ts compare data/benchmarks/parity-ollama.json data/benchmarks/parity-mlx.json

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLlmClient } from "../src/services/llm-client.js";
import { cosine } from "./lib/stats.js";

interface ParityFile {
  stack: string;
  embeddingModel: string;
  documents: number[][];
  queries: number[][];
}

const MIN_MEAN_COSINE = 0.98;

const DOCUMENTS = [
  "Dell PowerProtect Cyber Recovery keeps an isolated copy of critical data in an air-gapped vault.",
  "Pure Storage SafeMode snapshots cannot be deleted or modified, even with administrator credentials.",
  "NotPetya disrupted Merck's manufacturing and cost the company an estimated 870 million dollars in 2017.",
  "Basel hosts the global headquarters of Novartis and Roche and a dense cluster of biotech companies.",
  "21 CFR Part 11 defines FDA requirements for electronic records and electronic signatures.",
  "Semaglutide and tirzepatide lead the fast-growing GLP-1 market for diabetes and obesity.",
  "CrowdStrike Falcon provides endpoint detection and response through a lightweight cloud-managed agent.",
  "The NIS2 directive extends EU cybersecurity obligations to pharmaceutical manufacturers.",
  "Bug Bounty Switzerland runs ethical hacking programs for Swiss companies from Zurich.",
  "A manufacturing execution system coordinates batch production steps on the plant floor.",
];

const QUERIES = [
  "How does Dell isolate backups from ransomware?",
  "Can an attacker delete Pure Storage snapshots?",
  "What did the NotPetya attack cost Merck?",
  "Which pharma companies are based in Basel?",
  "What does 21 CFR Part 11 regulate?",
  "Which drugs dominate the GLP-1 market?",
  "What is CrowdStrike Falcon?",
  "Does NIS2 apply to drug manufacturers?",
  "Who is Bug Bounty Switzerland?",
  "What does an MES do in a pharma plant?",
];

async function save(path: string): Promise<void> {
  const client = getLlmClient();
  const file: ParityFile = {
    stack: client.stack.name,
    embeddingModel: client.stack.embeddingModel,
    documents: await client.embedMany(DOCUMENTS, "document"),
    queries: await client.embedMany(QUERIES, "query"),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file), "utf-8");
  console.log(`Saved ${DOCUMENTS.length + QUERIES.length} embeddings from ${file.stack} to ${path}`);
}

async function compare(pathA: string, pathB: string): Promise<void> {
  const a = JSON.parse(await readFile(pathA, "utf-8")) as ParityFile;
  const b = JSON.parse(await readFile(pathB, "utf-8")) as ParityFile;
  const vectorsA = [...a.documents, ...a.queries];
  const vectorsB = [...b.documents, ...b.queries];

  if (vectorsA.length !== vectorsB.length) {
    console.error(`Different sample counts: ${vectorsA.length} vs ${vectorsB.length}`);
    process.exit(1);
  }

  const scores = vectorsA.map((vector, i) => cosine(vector, vectorsB[i]));
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const min = Math.min(...scores);

  console.log(`${a.stack} vs ${b.stack}: mean cosine ${mean.toFixed(4)}, min ${min.toFixed(4)} over ${scores.length} texts`);
  if (mean < MIN_MEAN_COSINE) {
    console.error(`FAIL: mean cosine below ${MIN_MEAN_COSINE}`);
    process.exit(1);
  }
  console.log("PASS");
}

async function main(): Promise<void> {
  const [command, first, second] = process.argv.slice(2);
  if (command === "save" && first) return save(first);
  if (command === "compare" && first && second) return compare(first, second);
  console.error("Usage: embedding-parity.ts save <file> | compare <a> <b>");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
