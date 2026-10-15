// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "examples/**", "*.cjs", "tests/e2e/helpers/**"]
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "off"
    }
  },
  {
    // Type-aware rules, on the TypeScript sources only. Not the whole
    // `recommendedTypeChecked` set: most of the rest fires on load-bearing
    // runtime guards that the types merely *believe* are unnecessary (the
    // `spawnSync().stdout` guards in infra/process are typed non-nullable by
    // @types/node but really are null when the spawn fails), and "fixing"
    // those would introduce the crash the guard exists to prevent.
    //
    // These four are the ones that catch real defects in async code - a
    // forgotten `await` on a kill or a pid-file write is exactly the kind of
    // thing that leaks a process - and the codebase passes all four clean.
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error"
    }
  },
  {
    // Plain Node ESM tooling, outside the TypeScript program - so `no-undef`
    // actually applies here (typescript-eslint disables it for .ts, where the
    // compiler knows the globals) and has to be told what Node provides.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } }
  }
);
