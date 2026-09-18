#!/usr/bin/env python3
"""Refuse to serve a stack whose embeddings no longer match the index it shares.

Usage: embedding-parity.py <base-url> <model> <fixture.json>
Exits 0 when cosine >= 0.9999 against the recorded reference vector, 1 otherwise.
"""
import json
import math
import sys
import urllib.request

MIN_COSINE = 0.9999


def main() -> int:
    base_url, model, fixture_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(fixture_path, encoding="utf-8") as handle:
        fixture = json.load(handle)
    body = json.dumps({"model": model, "input": fixture["text"]}).encode()
    request = urllib.request.Request(
        f"{base_url}/v1/embeddings", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            vector = json.loads(response.read())["data"][0]["embedding"]
    except Exception as error:  # noqa: BLE001 - any failure here must fail the switch
        print(f"embedding parity check failed: {error}", file=sys.stderr)
        return 1

    reference = fixture["vector"]
    if len(vector) != len(reference):
        print(f"embedding parity check failed: {len(vector)} dims, expected {len(reference)}", file=sys.stderr)
        return 1
    dot = sum(a * b for a, b in zip(vector, reference))
    norm = math.sqrt(sum(a * a for a in vector)) * math.sqrt(sum(b * b for b in reference))
    cosine = dot / norm if norm else 0.0
    print(f"cosine={round(cosine, 6)}")
    if cosine < MIN_COSINE:
        print(
            f"embedding parity check failed: cosine={round(cosine, 6)} < {MIN_COSINE}; "
            f"this stack shares an index built with {fixture['model']}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
