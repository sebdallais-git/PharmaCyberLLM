# oMLX Stack Verification

## Task 0: verification spike (2026-09-18)

Run on the Mac mini (M4 Pro, 48 GB) with the MLX stack active. Only the MLX **chat** server (:8080) was stopped for the spike; the MLX **embedding** server (:8081) stayed up so the reference vector could be recorded against it. oMLX ran from a scratch venv on :8090.

### Version

```
commit cbc1a80397796d91aa64a58c8562d5138ae125e3 (2026-09-18)
omlx --version -> 0.7.0.dev3
```

`OMLX_VERSION` for the plan: `cbc1a80`.

### Model discovery

With `--model-dir ~/.cache/huggingface/hub`, oMLX found both models already on disk, so nothing is downloaded twice:

```
models: ['mlx-community--Qwen3-Embedding-0.6B-8bit', 'mlx-community--Qwen3.8-27B-4bit']
```

These are the ids the stack config must use (double dashes, not slashes).

### Cache limits

Richer than the plan assumed. `omlx serve --help` offers:

```
--paged-ssd-cache-dir PAGED_SSD_CACHE_DIR      directory for the paged SSD cache
--paged-ssd-cache-max-size PAGED_SSD_CACHE_MAX_SIZE
--hot-cache-max-size HOT_CACHE_MAX_SIZE
--memory-guard-gb MEMORY_GUARD_GB              memory guard ceiling
--no-cache                                     disable caching entirely
```

So the disk budget is a real flag, not a settings-file guess. Task 2 should pass `--paged-ssd-cache-max-size` (and may pass `--memory-guard-gb`) rather than leaving the cache unbounded.

### Thinking switch

```
without chat_template_kwargs: content '4' | reasoning field present: True
with    chat_template_kwargs: content '4' | reasoning field present: False
```

oMLX honours `chat_template_kwargs: { enable_thinking: false }`, so the omlx stack uses the same `chatExtraBody` as the mlx stack.

### Embedding reference

```
dims 1024 1024   cosine 1.0
```

`__tests__/fixtures/embedding-reference.json` holds the probe sentence and the 1024-float vector from the MLX embedding server (20,680 bytes). The parity guard in Task 3 compares against it.

### Cache size after the spike

`~/.omlx` reached 4.3 GB after the earlier trial plus this spike, with the default unbounded cache — which is why Task 2 sets an explicit ceiling.
