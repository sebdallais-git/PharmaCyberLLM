import { describe, expect, it } from "@jest/globals";
import { readEnvWithFallback } from "../src/config/env-names.js";

describe("readEnvWithFallback", () => {
  it("prefers the new name", () => {
    expect(readEnvWithFallback({ PHARMAITCHAT_API_TOKEN: "new", PHARMALLM_API_TOKEN: "old" }, "API_TOKEN")).toBe("new");
  });

  it("falls back to the legacy name so an unedited ~/.hermes/.env keeps working", () => {
    expect(readEnvWithFallback({ PHARMALLM_API_TOKEN: "old" }, "API_TOKEN")).toBe("old");
  });

  it("treats blank as absent on both names", () => {
    expect(readEnvWithFallback({ PHARMAITCHAT_API_TOKEN: "  ", PHARMALLM_API_TOKEN: " " }, "API_TOKEN")).toBeUndefined();
    expect(readEnvWithFallback({}, "API_TOKEN")).toBeUndefined();
  });

  it("trims a padded value", () => {
    expect(readEnvWithFallback({ PHARMAITCHAT_URL: " http://x " }, "URL")).toBe("http://x");
  });
});
