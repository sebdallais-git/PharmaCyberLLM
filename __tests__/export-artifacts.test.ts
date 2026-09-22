import { describe, expect, it } from "@jest/globals";
import { assertExternalSafe } from "../src/services/artifact.js";
import {
  ARTIFACT_KINDS,
  gather,
  isArtifactKind,
  type ArtifactKind,
  type GatherDeps,
} from "../src/services/export-artifacts.js";

const deps: GatherDeps = {
  async incumbency() {
    return [
      { account: "roche", segment: "storage-file", vendors: ["dell"] },
      { account: "roche", segment: "storage-block", vendors: ["everpure"] },
    ];
  },
  async positions() {
    return [{ segment: "storage-file", position: "strong", confidence: "medium", rationale: "Contested." }];
  },
  async news() {
    return [{ title: "Roche builds AI factory", url: "https://example.test/a", publishedAt: "2026-09-20" }];
  },
};

describe("isArtifactKind", () => {
  it("accepts declared kinds and rejects others", () => {
    expect(isArtifactKind("account-brief")).toBe(true);
    expect(isArtifactKind("incumbency-matrix")).toBe(true);
    expect(isArtifactKind("sales-forecast")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isArtifactKind(undefined)).toBe(false);
    expect(isArtifactKind(42)).toBe(false);
    expect(isArtifactKind(null)).toBe(false);
  });
});

describe("gather", () => {
  it("includes incumbency for an internal account brief", async () => {
    const artifact = await gather("account-brief", "internal", { account: "roche", vendor: "dell" }, deps);

    const headings = artifact.sections.map((s) => s.heading);
    expect(headings).toContain("Incumbency by segment");
  });

  // The external filter is applied HERE, not at render time: the internal
  // content is never in the object a renderer sees.
  it("omits incumbency and confidence from an external account brief", async () => {
    const artifact = await gather("account-brief", "external", { account: "roche", vendor: "dell" }, deps);

    const text = JSON.stringify(artifact).toLowerCase();
    expect(text).not.toContain("incumben");
    expect(text).not.toContain("confidence");
  });

  it("turns news into citations so a claim can be traced", async () => {
    const artifact = await gather("account-brief", "external", { account: "roche", vendor: "dell" }, deps);

    expect(artifact.citations).toEqual([
      { id: "c1", title: "Roche builds AI factory", url: "https://example.test/a" },
    ]);
  });

  it("builds a matrix of accounts against segments", async () => {
    const artifact = await gather("incumbency-matrix", "internal", {}, deps);
    const table = artifact.sections.find((s) => s.kind === "table");

    expect(table).toBeDefined();
    if (table?.kind === "table") {
      expect(table.columns).toEqual(["segment", "roche"]);
      expect(table.rows).toContainEqual(["storage-file", "dell"]);
    }
  });

  it("refuses an incumbency matrix for an external audience", async () => {
    // The whole artifact is internal by nature; there is no external version.
    await expect(gather("incumbency-matrix", "external", {}, deps)).rejects.toThrow(/internal/i);
  });

  // Finding 2: a vendor comparison stripped of competitive framing has
  // nothing left to compare, so it must refuse rather than degrade to a
  // news list under a comparison title. Mirrors the incumbency-matrix
  // refusal above.
  it("refuses a vendor comparison for an external audience", async () => {
    await expect(gather("vendor-comparison", "external", { account: "roche", vendor: "dell" }, deps)).rejects.toThrow(
      /internal/i,
    );
  });

  // Finding 1 & 4: no option may silently default. A missing identifying
  // option must throw naming the option, not fall back to a hardcoded
  // vendor or filter on the empty string.
  describe("required options", () => {
    it("throws naming the missing option for an internal account brief with no account", async () => {
      await expect(gather("account-brief", "internal", { vendor: "dell" }, deps)).rejects.toThrow(/account/i);
    });

    it("throws naming the missing option for an external account brief with no account", async () => {
      await expect(gather("account-brief", "external", { vendor: "dell" }, deps)).rejects.toThrow(/account/i);
    });

    it("throws naming the missing option for an internal account brief with no vendor", async () => {
      await expect(gather("account-brief", "internal", { account: "roche" }, deps)).rejects.toThrow(/vendor/i);
    });

    it("throws naming the missing option for an internal vendor comparison with no vendor", async () => {
      await expect(gather("vendor-comparison", "internal", { account: "roche" }, deps)).rejects.toThrow(/vendor/i);
    });

    it("throws naming the missing option for an internal vendor comparison with no account", async () => {
      await expect(gather("vendor-comparison", "internal", { vendor: "dell" }, deps)).rejects.toThrow(/account/i);
    });

    it("never assumes a hardcoded vendor when vendor is omitted", async () => {
      // Before the fix, a missing vendor silently defaulted to "dell" instead
      // of throwing. Assert the rejection, not any particular vendor name.
      await expect(gather("account-brief", "internal", { account: "roche" }, deps)).rejects.toThrow();
    });
  });

  it("includes competitive position with confidence for an internal vendor comparison", async () => {
    const artifact = await gather("vendor-comparison", "internal", { account: "roche", vendor: "dell" }, deps);

    const headings = artifact.sections.map((s) => s.heading);
    expect(headings).toContain("Competitive position");
  });

  it("titles a vendor comparison after the vendor, not the account", async () => {
    const artifact = await gather("vendor-comparison", "internal", { account: "roche", vendor: "dell" }, deps);

    expect(artifact.title).toBe("dell — competitive view");
  });

  it("still carries traceable citations for an internal audience", async () => {
    const artifact = await gather("account-brief", "internal", { account: "roche", vendor: "dell" }, deps);

    expect(artifact.citations).toEqual([
      { id: "c1", title: "Roche builds AI factory", url: "https://example.test/a" },
    ]);
  });

  // The single most important property of this module: for every kind that
  // has an external form, the gathered object itself — not a rendered file —
  // must be free of every internal-only term. Free-text fields (rationale)
  // deliberately contain the forbidden words here, to prove they are excluded
  // because the section that carries them is never built for this audience,
  // not because of a string filter applied afterwards.
  // "incumbency-matrix" and "vendor-comparison" both refuse an external
  // gather entirely (see the two "refuses..." tests above); there is no
  // artifact for a substring check to run against for either.
  const kindsWithExternalForm = ARTIFACT_KINDS.filter(
    (k): k is Exclude<ArtifactKind, "incumbency-matrix" | "vendor-comparison"> =>
      k !== "incumbency-matrix" && k !== "vendor-comparison",
  );

  describe.each(kindsWithExternalForm)("external %s", (kind) => {
    const loadedDeps: GatherDeps = {
      async incumbency() {
        return [{ account: "roche", segment: "storage-file", vendors: ["dell"] }];
      },
      async positions() {
        return [
          {
            segment: "storage-file",
            position: "leader",
            confidence: "high",
            rationale: "Defend the incumbency here; a displacement play would open a greenfield account elsewhere.",
          },
        ];
      },
      async news() {
        return [{ title: "Roche builds AI factory", url: "https://example.test/a", publishedAt: "2026-09-20" }];
      },
    };

    it("produces no section, title or subtitle containing an internal-only term", async () => {
      const artifact = await gather(kind, "external", { account: "roche", vendor: "dell" }, loadedDeps);

      const text = JSON.stringify(artifact).toLowerCase();
      for (const term of ["incumben", "confidence", "displace", "defend", "greenfield"]) {
        expect(text).not.toContain(term);
      }

      // Cross-check against the renderer-side backstop too: it must agree the
      // object is safe, but the test above is the one that matters — it
      // proves the content was never assembled, not merely that a scanner
      // failed to find it after the fact.
      expect(() => assertExternalSafe(artifact)).not.toThrow();
    });
  });

  // Finding 3: the substring checks above can only catch a leak that spells
  // out a banned word. A "Competitive position" section with columns
  // ["segment", "position", "rationale"] and values like "leader"/"absent"
  // carries the full competitive meaning with no banned substring anywhere,
  // and would pass both the test above AND assertExternalSafe. These two
  // assertions are what actually hold the boundary:
  //   (a) whitelist the exact section headings an external artifact may
  //       contain, so an added section fails immediately regardless of name;
  //   (b) prove the internal-only deps (incumbency, positions) are never
  //       even called for an external gather — the "never fetched" property,
  //       not just "not present in the output".
  // Driven from ARTIFACT_KINDS (not a hand-picked subset) so a future kind
  // is covered automatically, whether it turns out to have an external form
  // or to refuse one.
  it("whitelists the external section shape and never calls internal deps, for every kind", async () => {
    for (const kind of ARTIFACT_KINDS) {
      let incumbencyCalls = 0;
      let positionsCalls = 0;
      const countingDeps: GatherDeps = {
        async incumbency() {
          incumbencyCalls++;
          return [{ account: "roche", segment: "storage-file", vendors: ["dell"] }];
        },
        async positions(vendor: string) {
          positionsCalls++;
          return [{ segment: "storage-file", position: "leader", confidence: "high", rationale: "Defend it." }];
        },
        async news() {
          return [{ title: "Roche builds AI factory", url: "https://example.test/a", publishedAt: "2026-09-20" }];
        },
      };

      let artifact;
      try {
        artifact = await gather(kind, "external", { account: "roche", vendor: "dell" }, countingDeps);
      } catch {
        // This kind refuses an external form entirely (incumbency-matrix,
        // vendor-comparison); that refusal has its own test. Either way the
        // internal deps must never have been touched, so fall through to
        // the same zero-call assertions below.
      }

      if (artifact !== undefined) {
        expect(artifact.sections.map((s) => s.heading)).toEqual(["Recent developments"]);
      }
      expect(incumbencyCalls).toBe(0);
      expect(positionsCalls).toBe(0);
    }
  });
});
