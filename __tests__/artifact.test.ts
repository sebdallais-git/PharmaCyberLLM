import { describe, expect, it } from "@jest/globals";
import { assertExternalSafe, isAudience, type Artifact } from "../src/services/artifact.js";

const base = (over: Partial<Artifact> = {}): Artifact => ({
  title: "Roche — account brief",
  audience: "external",
  generatedAt: "2026-09-22T10:00:00.000Z",
  sections: [],
  citations: [],
  ...over,
});

describe("isAudience", () => {
  it("accepts the two declared audiences", () => {
    expect(isAudience("internal")).toBe(true);
    expect(isAudience("external")).toBe(true);
  });

  it("rejects anything else, including undefined", () => {
    expect(isAudience(undefined)).toBe(false);
    expect(isAudience("customer")).toBe(false);
  });
});

describe("assertExternalSafe", () => {
  // The gatherer is supposed to omit these for an external artifact. This is
  // the backstop: a leak here reaches a customer.
  it("passes an external artifact with no internal fields", () => {
    expect(() => assertExternalSafe(base())).not.toThrow();
  });

  it("rejects an external artifact carrying an incumbency section", () => {
    const artifact = base({
      sections: [{ kind: "table", heading: "Incumbency", columns: ["segment"], rows: [["storage-file"]] }],
    });
    expect(() => assertExternalSafe(artifact)).toThrow(/incumbency/i);
  });

  it("rejects an external artifact carrying a confidence field", () => {
    const artifact = base({
      sections: [{ kind: "facts", heading: "Position", items: [{ label: "confidence", value: "high" }] }],
    });
    expect(() => assertExternalSafe(artifact)).toThrow(/confidence/i);
  });

  it("ignores internal artifacts entirely", () => {
    const artifact = base({
      audience: "internal",
      sections: [{ kind: "facts", heading: "Position", items: [{ label: "confidence", value: "high" }] }],
    });
    expect(() => assertExternalSafe(artifact)).not.toThrow();
  });

  it("rejects an external artifact whose prose leaks competitive framing", () => {
    const artifact = base({
      sections: [
        {
          kind: "prose",
          heading: "Summary",
          body: "We are well positioned to displace the incumbent.",
          cites: [],
        },
      ],
    });
    expect(() => assertExternalSafe(artifact)).toThrow(/displace/i);
  });

  it("rejects an external artifact whose chart spec carries an internal field", () => {
    const artifact = base({
      sections: [{ kind: "chart", heading: "Position", spec: { field: "confidence" } }],
    });
    expect(() => assertExternalSafe(artifact)).toThrow(/confidence/i);
  });

  // The title and subtitle are rendered as prominently as any section — the PDF
  // writes the title into the document metadata and the deck puts it on slide 1.
  // A leak there reaches the customer exactly as a section leak would.
  it("rejects an external artifact whose title leaks internal framing", () => {
    const artifact = base({ title: "Incumbency matrix" });

    expect(() => assertExternalSafe(artifact)).toThrow(/internal-only/i);
  });

  it("rejects an external artifact whose subtitle leaks internal framing", () => {
    const artifact = base({ subtitle: "where we defend and where we displace" });

    expect(() => assertExternalSafe(artifact)).toThrow(/internal-only/i);
  });

  it("allows external prose that says nothing internal", () => {
    const artifact = base({
      sections: [{ kind: "prose", heading: "Summary", body: "Roche is scaling its AI estate.", cites: [] }],
    });
    expect(() => assertExternalSafe(artifact)).not.toThrow();
  });
});
