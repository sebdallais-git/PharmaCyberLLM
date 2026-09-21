// Jest runs TypeScript tests as native ES modules (package.json has "type": "module")
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  // The MCP service is a separate package with its own Jest setup; data/ holds scratch installs
  // .worktrees holds stale checkouts of this repo; jest would otherwise collect
  // their copies of every suite and report failures that no longer exist here.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/mcp/", "<rootDir>/data/", "<rootDir>/.worktrees/"],
  moduleNameMapper: {
    // Source files import siblings as "./x.js"; point Jest at the .ts file
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.test.json" }],
  },
};
