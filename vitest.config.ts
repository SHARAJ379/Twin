import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/checks/**"],
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 70,
        functions: 80
      }
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          testTimeout: 30_000
        }
      },
      {
        test: {
          name: "e2e",
          include: ["tests/**/*.test.ts"],
          // Each of these boots real server processes and binds real ports. Run
          // the files in parallel and they compete for a small CI runner's 2-4
          // cores, so a boot that takes ~1s idle blows its deadline and fails a
          // test that has nothing wrong with it. Sequential is slower but honest.
          fileParallelism: false,
          // A single test can boot an instance several times (control, split A+B,
          // then a restart), and a Go app compiles before the first of them.
          testTimeout: 180_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
});
