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
    // Plain Node ESM tooling, outside the TypeScript program - so `no-undef`
    // actually applies here (typescript-eslint disables it for .ts, where the
    // compiler knows the globals) and has to be told what Node provides.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } }
  }
);
