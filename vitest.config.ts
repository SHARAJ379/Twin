import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Several tests boot a real `npm start` process (examples/broken-express) -
    // slower than unit tests, especially in CI.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/checks/**"],
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 70,
        functions: 80
      }
    }
  }
});
