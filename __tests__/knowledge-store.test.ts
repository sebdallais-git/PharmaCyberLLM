import { describe, expect, it } from "@jest/globals";
import { decodeEmbedding, encodeEmbedding, parseIndexFile, serializeIndex } from "../src/services/knowledge-store.js";

const meta = { stack: "ollama", embeddingModel: "qwen3-embedding:0.6b-q8_0", dim: 3 };

describe("embedding encoding", () => {
  it("round-trips vectors through base64 Float32", () => {
    const decoded = decodeEmbedding(encodeEmbedding([0.25, -1.5, 3.125]));
    expect(Array.from(decoded)).toEqual([0.25, -1.5, 3.125]);
  });

  it("decodes small vectors whose Buffer comes from Node's shared pool", () => {
    // Small Buffers share a pool and can start at an offset that isn't a multiple of 4
    const decoded = decodeEmbedding(encodeEmbedding([0.1, 0.2, 0.3]));
    expect(decoded[0]).toBeCloseTo(0.1, 6);
    expect(decoded[2]).toBeCloseTo(0.3, 6);
  });
});

describe("index file format", () => {
  it("round-trips metadata and chunks", () => {
    const json = serializeIndex(meta, [
      { id: "a-0", source: "a.md", content: "hello", embedding: Float32Array.from([1, 0, 0]) },
    ]);
    const parsed = parseIndexFile(JSON.parse(json) as unknown);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]).toMatchObject({ id: "a-0", source: "a.md", content: "hello" });
    expect(Array.from(parsed.chunks[0].embedding)).toEqual([1, 0, 0]);
  });

  it("treats a legacy array index as having no metadata and no usable chunks", () => {
    const parsed = parseIndexFile([{ id: "x", source: "x", content: "x", embedding: [1, 2] }]);
    expect(parsed).toEqual({ meta: null, chunks: [] });
  });
});
