#!/usr/bin/env python3
"""Smoke test for an OpenAI-compatible /v1/embeddings endpoint (MLX embedding server or Ollama).

Usage:
  python3 python/smoke_embeddings.py --url http://localhost:8081 --model mlx-community/Qwen3-Embedding-0.6B-8bit
  python3 python/smoke_embeddings.py --url http://localhost:11434 --model qwen3-embedding:0.6b-q8_0
"""

import argparse
import json
import math
import sys
import urllib.request

# Must match QUERY_INSTRUCTION in src/services/llm-client.ts
QUERY_INSTRUCTION = (
    "Given a question about the pharmaceutical industry or its cybersecurity, "
    "retrieve passages that answer the question"
)
EXPECTED_DIM = 1024


def embed(url: str, model: str, texts: list[str]) -> list[list[float]]:
    request = urllib.request.Request(
        f"{url}/v1/embeddings",
        data=json.dumps({"model": model, "input": texts}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        rows = json.load(response)["data"]
    return [row["embedding"] for row in sorted(rows, key=lambda r: r["index"])]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    query = f"Instruct: {QUERY_INSTRUCTION}\nQuery:How does Dell PowerProtect Cyber Recovery isolate backup data?"
    relevant = (
        "Dell PowerProtect Cyber Recovery keeps a copy of critical data in an air-gapped vault "
        "that is disconnected from the production network."
    )
    unrelated = "Semaglutide is a GLP-1 receptor agonist used to treat type 2 diabetes and obesity."

    vectors = embed(args.url, args.model, [query, relevant, unrelated])
    repeat = embed(args.url, args.model, [relevant])[0]

    failures = []
    for i, vector in enumerate(vectors):
        if len(vector) != EXPECTED_DIM:
            failures.append(f"vector {i} has {len(vector)} dimensions, expected {EXPECTED_DIM}")
        norm = math.sqrt(sum(x * x for x in vector))
        if abs(norm - 1.0) > 1e-3:
            failures.append(f"vector {i} has norm {norm:.4f}, expected 1.0")

    determinism = cosine(vectors[1], repeat)
    if determinism < 0.999:
        failures.append(f"the same input gave different vectors (cosine {determinism:.6f})")

    relevant_score = cosine(vectors[0], vectors[1])
    unrelated_score = cosine(vectors[0], vectors[2])
    if relevant_score <= unrelated_score:
        failures.append(f"relevant passage scored {relevant_score:.3f}, unrelated {unrelated_score:.3f}")

    print(
        f"dims={len(vectors[0])} relevant={relevant_score:.3f} "
        f"unrelated={unrelated_score:.3f} determinism={determinism:.6f}"
    )
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
