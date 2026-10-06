import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
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
