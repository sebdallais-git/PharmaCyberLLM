import { describe, expect, it } from "@jest/globals";
import { toBatches } from "../src/utils/batches.js";

describe("toBatches", () => {
  it("splits items into batches of the given size, keeping order", () => {
    expect(toBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no batches for an empty list", () => {
    expect(toBatches([], 3)).toEqual([]);
  });

  it("rejects a non-positive batch size", () => {
    expect(() => toBatches([1], 0)).toThrow("Batch size must be a positive integer");
  });
});
