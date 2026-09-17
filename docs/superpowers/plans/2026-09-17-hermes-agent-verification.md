# Hermes Agent Integration — Verification

## Source verification

Before planning, Hermes Agent source was read at commit `228022ef5b209cb0a3d739394edddf887e1db0f6` (version 0.21.3) without installing anything. The findings are recorded in the spec's "Amendments from source verification" section (`docs/superpowers/specs/2026-09-17-hermes-agent-integration-design.md`). The one that changed the code: the Streamable HTTP MCP client's 300 s read timeout, which led to keepalive notifications in `pharmallm-mcp`.

## 64K context (Task 7, 2026-09-17, Apple M4 Pro, 48 GB)

### Ollama

`scripts/switch-stack.sh ollama` recreated the model from the Modelfile, reusing the pulled weights with no download:

```
using existing layer sha256:4c6a8e84…
creating new layer sha256:85d75956…
writing manifest
success
[switch-stack] Warming up ollama...
[switch-stack] PharmaLLM is up on the ollama stack
num_ctx                        65536
NAME                         ID              SIZE      PROCESSOR    CONTEXT
qwen3-embedding:0.6b-q8_0    ac6da0dfba84    4.0 GB    100% GPU     32768
qwen3.8-pharma:latest        6674d043f8a8    19 GB     100% GPU     65536
```

The `ollama create` progress lines (stderr) show in the switch output; `ensure_ollama_ctx` only silences stdout. A later switch logs `qwen3.8-pharma context is 65536` and skips the recreate.

Probe: a ≈16.7K-token system prompt through `/v1` (streamed, max 48 tokens), sent cold and then warm (same prefix, new question):

```
PhysMem: 47G used (26G wired, 1239M compressor), 309M unused.
{"prompt_tokens": 16716, "ttft_s": 156.3, "decode_tok_s": 11.3, "total_s": 159.2}
{"prompt_tokens": 16715, "ttft_s": 5.8, "decode_tok_s": 11.6, "total_s": 6.8}
PhysMem: 47G used (26G wired, 1236M compressor), 274M unused.
vm.swapusage: total = 7168.00M  used = 6168.75M  free = 999.25M
```

Memory:
- **Largest processes by RSS:** Ollama chat runner 20.7 GB, embedding runner 3.0 GB, Docker VM 1.0 GB (Neo4j 0.54 GiB, SearXNG 0.16 GiB).
- **Pressure:** `memory_pressure` reports 41% free and `vm.memory_pressure` 0 (normal).
- **Swap:** the swap figure accumulated from earlier switches and benchmarks. It was not caused by this probe.

### MLX

```
--prompt-cache-bytes 8589934592
PhysMem: 47G used (3031M wired, 2651M compressor), 636M unused.
{"prompt_tokens": 16716, "ttft_s": 141.2, "decode_tok_s": 11.5, "total_s": 143.9}
{"prompt_tokens": 16715, "ttft_s": 0.8, "decode_tok_s": 12.4, "total_s": 1.0}
PhysMem: 47G used (26G wired, 2390M compressor), 93M unused.
System-wide memory free percentage: 40%
mlx chat RSS 12.1 GB
```

Back on Ollama afterwards: `ollama healthy`, 40% memory free.

### Summary

| | Ollama | MLX |
|---|---|---|
| Cold TTFT, 16.7K-token prompt | 156.3 s (≈107 tok/s prefill) | 141.2 s (≈118 tok/s prefill) |
| Warm TTFT, same prefix | 5.8 s | 0.8 s |
| Decode | 11.3–11.6 tok/s | 11.5–12.4 tok/s |
| Memory pressure | normal, 41% free | normal, 40% free |

The spec estimated a first reply of 90–130 s for a 10–15K prompt; a 16.7K prompt measures 141–156 s, which fits that estimate. Warm steps are much faster than estimated, especially on MLX.
