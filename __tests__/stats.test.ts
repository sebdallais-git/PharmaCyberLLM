import { describe, expect, it } from "@jest/globals";
import { cosine, jaccard, median, percentChange, percentile } from "../scripts/lib/stats.js";

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 50)).toBe(35);
    expect(percentile(values, 90)).toBe(50);
    expect(percentile(values, 0)).toBe(15);
  });

  it("returns null for no values", () => {
    expect(percentile([], 50)).toBeNull();
    expect(median([])).toBeNull();
  });

  it("does not reorder the input", () => {
    const values = [3, 1, 2];
    expect(median(values)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("jaccard", () => {
  it("measures overlap of two ID lists", () => {
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  it("treats two empty lists as identical", () => {
    expect(jaccard([], [])).toBe(1);
  });
});

describe("cosine", () => {
  it("is 1 for parallel vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 for a zero vector or different lengths", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1], [1, 1])).toBe(0);
  });
});

describe("percentChange", () => {
  it("computes the relative change", () => {
    expect(percentChange(20, 25)).toBeCloseTo(25);
    expect(percentChange(20, 15)).toBeCloseTo(-25);
  });

  it("returns null when the baseline is zero", () => {
    expect(percentChange(0, 5)).toBeNull();
  });
});
