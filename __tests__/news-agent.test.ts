// News agent handover (Task 8): getAgentTopics() used to return an in-file
// SEARCH_TOPICS constant; it now reads config/watchlist.yaml's `topics:`
// section instead (Task 1 moved every one of those 188 strings there). This
// only reads a local YAML file through loadWatchlist() -- no network, no
// live model, no ChromaDB -- so it is safe to exercise directly.

import { describe, expect, it } from "@jest/globals";
import { getAgentTopics } from "../src/services/news-agent.js";
import { loadWatchlist } from "../src/services/watchlist-config.js";

// The exact count and a few samples from the pre-refactor SEARCH_TOPICS
// constant, pinned here so a future edit to config/watchlist.yaml that drops
// a topic (rather than intentionally retiring it) is caught.
const PRE_REFACTOR_TOPIC_COUNT = 188;
const PRE_REFACTOR_SAMPLE_TOPICS = [
  "pharmaceutical merger acquisition",
  "pharma FDA approval",
  "pharma EMA approval",
  "NVIDIA Morpheus cybersecurity",
  "SAP zero-day exploit",
  "LockBit ransomware pharmaceutical healthcare",
  "blockbuster drug pipeline phase 3 readout",
];

describe("getAgentTopics", () => {
  it("returns every topic string the watchlist config defines", () => {
    const watchlist = loadWatchlist();
    const expected = watchlist.topics.map((topic) => topic.query);

    expect(getAgentTopics()).toEqual(expected);
  });

  it("keeps the exact count and a sample of strings the old in-file SEARCH_TOPICS constant held", () => {
    const topics = getAgentTopics();

    expect(topics).toHaveLength(PRE_REFACTOR_TOPIC_COUNT);
    for (const sample of PRE_REFACTOR_SAMPLE_TOPICS) {
      expect(topics).toContain(sample);
    }
  });

  it("returns a fresh array each call, not a shared mutable reference", () => {
    const first = getAgentTopics();
    first.push("mutated");

    expect(getAgentTopics()).not.toContain("mutated");
  });
});
