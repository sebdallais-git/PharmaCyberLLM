import { describe, expect, it } from "@jest/globals";
import { isVerdict, parseDecideConfig, VERDICTS } from "../src/services/decide-config.js";

const good = {
  base_url: "http://127.0.0.1:8000",
  model: "jev-latest",
  timeout_ms: 15000,
  thresholds: { resolved: 0.85, unresolved: 0.5 },
};

describe("isVerdict", () => {
  it("accepts the three declared verdicts and rejects anything else", () => {
    expect(VERDICTS).toEqual(["resolved", "review", "unresolved"]);
    expect(isVerdict("review")).toBe(true);
    expect(isVerdict("confident")).toBe(false);
    expect(isVerdict(undefined)).toBe(false);
  });
});

describe("parseDecideConfig", () => {
  it("reads a complete document", () => {
    const config = parseDecideConfig(good);

    expect(config.baseUrl).toBe("http://127.0.0.1:8000");
    expect(config.thresholds).toEqual({ resolved: 0.85, unresolved: 0.5 });
  });

  // The band only exists if resolved sits strictly above unresolved. Inverted
  // thresholds would silently delete the review band and turn every decision
  // into resolved-or-unresolved, which is the opposite of the design.
  it("rejects thresholds that do not leave a review band", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.85 } })).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.5 } })).toThrow(/threshold/i);
  });

  it("rejects a threshold outside 0..1", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 1.5, unresolved: 0.5 } })).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.85, unresolved: -0.1 } })).toThrow(/threshold/i);
  });

  it("rejects a missing or non-string base url", () => {
    const { base_url: _drop, ...noUrl } = good;
    expect(() => parseDecideConfig(noUrl)).toThrow(/base_url/i);
    expect(() => parseDecideConfig({ ...good, base_url: 8000 })).toThrow(/base_url/i);
  });

  it("rejects a non-object document", () => {
    expect(() => parseDecideConfig(null)).toThrow();
    expect(() => parseDecideConfig("thresholds")).toThrow();
  });
});
