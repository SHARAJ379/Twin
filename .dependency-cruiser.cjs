/**
 * Enforces the layer rule from TWIN_ARCHITECTURE.md §2:
 *   domain <- application <- ports <- infra/adapters/checks/tracer/report <- cli
 * Arrows point inward (toward domain). Imports may only flow outward -> inward.
 * `cli` is the composition root and may import anything.
 */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment:
        "domain/ must have zero imports from any other layer (invariant I6: pure, no I/O).",
      severity: "error",
      from: { path: "^src/domain" },
      to: {
        path: "^src/(application|ports|infra|adapters|checks|tracer|report|cli)"
      }
    },
    {
      name: "ports-depend-only-on-domain",
      comment: "ports/ defines interfaces; it may reference domain types but nothing else.",
      severity: "error",
      from: { path: "^src/ports" },
      to: { path: "^src/(application|infra|adapters|checks|tracer|report|cli)" }
    },
    {
      name: "application-depends-only-on-domain-and-ports",
      comment:
        "application/ orchestrates via ports (dependency inversion); it must not import concrete infra/adapters/checks/tracer/report, and never cli.",
      severity: "error",
      from: { path: "^src/application" },
      to: { path: "^src/(infra|adapters|checks|tracer|report|cli)" }
    },
    {
      name: "outer-layers-never-import-cli",
      comment: "cli/ is the composition root; nothing else may depend on it.",
      severity: "error",
      from: { path: "^src/(domain|ports|application|infra|adapters|checks|tracer|report)" },
      to: { path: "^src/cli" }
    },
    {
      name: "no-circular",
      comment: "Circular imports make the layer rule unverifiable.",
      severity: "error",
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
    reporterOptions: {
      text: { highlightFocused: true }
    }
  }
};
