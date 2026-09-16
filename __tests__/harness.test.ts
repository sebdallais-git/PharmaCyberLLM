import { describe, expect, it } from "@jest/globals";
import { isSupportedFile } from "../src/services/file-parser.js";

describe("test harness", () => {
  it("loads ESM source modules that use import.meta and .js specifiers", () => {
    expect(isSupportedFile("notes.md")).toBe(true);
    expect(isSupportedFile("image.png")).toBe(false);
  });
});
