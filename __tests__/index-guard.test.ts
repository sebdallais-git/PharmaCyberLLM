import { describe, expect, it } from "@jest/globals";
import { buildStacks } from "../src/config/llm-stacks.js";
import {
  assertIndexUsable,
  checkIndexMeta,
  expectedIndexMeta,
  indexMetaFromChroma,
  indexMetaToChroma,
  setIndexStatus,
} from "../src/services/index-guard.js";

const expected = expectedIndexMeta(buildStacks({}).mlx);

describe("expectedIndexMeta", () => {
  it("describes the stack's embedding space", () => {
    expect(expected).toEqual({ stack: "mlx", embeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit", dim: 1024 });
  });
});

// F1: mlx and omlx share knowledge_base_mlx and .index.mlx.json because oMLX serves the identical
// embedding model (cosine 1.000000). The guard used to key on stack.name and stack.embeddingModel,
// both of which differ between the two, so every mlx↔omlx switch failed the check, took the rebuild
// branch, and deleted the live collection. These pin the shared index identity instead.
describe("expectedIndexMeta across the stacks that share an index", () => {
  const { ollama, mlx, omlx } = buildStacks({});

  it("gives omlx the same index identity as mlx", () => {
    expect(expectedIndexMeta(omlx)).toEqual(expectedIndexMeta(mlx));
  });

  it("accepts an mlx-built index while omlx is active, and the reverse", () => {
    const mlxBuilt = expectedIndexMeta(mlx);
    const omlxBuilt = expectedIndexMeta(omlx);
    expect(checkIndexMeta(expectedIndexMeta(omlx), mlxBuilt, 1024, "ChromaDB collection").ok).toBe(true);
    expect(checkIndexMeta(expectedIndexMeta(mlx), omlxBuilt, 1024, "ChromaDB collection").ok).toBe(true);
  });

  it("still rejects an ollama-built index on both mlx and omlx", () => {
    const ollamaBuilt = expectedIndexMeta(ollama);
    expect(expectedIndexMeta(ollama)).not.toEqual(expectedIndexMeta(mlx));
    expect(checkIndexMeta(expectedIndexMeta(mlx), ollamaBuilt, 1024, "in-memory index").ok).toBe(false);
    expect(checkIndexMeta(expectedIndexMeta(omlx), ollamaBuilt, 1024, "in-memory index").ok).toBe(false);
  });

  // The writers (knowledge-store.resetIndex, chromadb-store.getCollectionId) stamp whatever
  // expectedIndexMeta returns, so pinning the stamped shape here pins reading and writing together.
  it("stamps the shared identity into the Chroma metadata a switch to omlx would write", () => {
    expect(indexMetaToChroma(expectedIndexMeta(omlx))).toEqual({
      stack: "mlx",
      embedding_model: "mlx-community/Qwen3-Embedding-0.6B-8bit",
      dim: 1024,
    });
    expect(indexMetaToChroma(expectedIndexMeta(omlx))).toEqual(indexMetaToChroma(expectedIndexMeta(mlx)));
  });
});

describe("checkIndexMeta", () => {
  it("accepts a matching index", () => {
    expect(checkIndexMeta(expected, { ...expected }, 1024, "ChromaDB collection")).toEqual({ ok: true, reason: "" });
  });

  it("rejects an index without metadata", () => {
    const check = checkIndexMeta(expected, null, null, "in-memory index");
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("in-memory index: index has no stack metadata — run scripts/reindex-stack.ts");
  });

  it("lists every mismatching field", () => {
    const check = checkIndexMeta(
      expected,
      { stack: "ollama", embeddingModel: "nomic-embed-text", dim: 768 },
      null,
      "ChromaDB collection"
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("stack ollama ≠ mlx");
    expect(check.reason).toContain("embedding model nomic-embed-text ≠ mlx-community/Qwen3-Embedding-0.6B-8bit");
    expect(check.reason).toContain("dim 768 ≠ 1024");
  });

  it("rejects an embedding server that returns the wrong dimension", () => {
    const check = checkIndexMeta(expected, { ...expected }, 768, "in-memory index");
    expect(check).toEqual({ ok: false, reason: "in-memory index: embedding server returned 768 dimensions, expected 1024" });
  });
});

describe("Chroma metadata", () => {
  it("round-trips index metadata", () => {
    const chroma = { "hnsw:space": "cosine", ...indexMetaToChroma(expected) };
    expect(indexMetaFromChroma(chroma)).toEqual(expected);
  });

  it("returns null for collections created before the stack switch", () => {
    expect(indexMetaFromChroma({ "hnsw:space": "cosine" })).toBeNull();
    expect(indexMetaFromChroma(null)).toBeNull();
  });
});

describe("assertIndexUsable", () => {
  it("throws while the index is incompatible and passes once it is fixed", () => {
    setIndexStatus({ ok: false, reason: "dim 768 ≠ 1024" });
    expect(() => assertIndexUsable()).toThrow("Search refused: dim 768 ≠ 1024");
    setIndexStatus({ ok: true, reason: "" });
    expect(() => assertIndexUsable()).not.toThrow();
  });
});
