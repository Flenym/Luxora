/**
 * axe-core accessibility auditing for the Luxora web messenger E2E gate.
 *
 * - Runs pinned axe-core (dev dependency, injected from node_modules) inside the
 *   page and collects WCAG 2.x A/AA violations grouped by rule.
 * - Fails the gate on `critical`/`serious` impact only; `moderate`/`minor` are
 *   reported as non-blocking warnings (the product-truth/testing policy).
 * - Writes machine-readable JSON plus a readable markdown summary into
 *   `<artifacts>/a11y/`.
 * - Supports an empty-by-default baseline allowlist
 *   (`tools/web-e2e/a11y-baseline.json`); exceptions must be approved by the
 *   Lead and carry a reason.
 *
 * This module never edits the product: it only measures and reports.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ROOT } from "./environment.mjs";

/** WCAG 2.x A/AA rule tags (2.0, 2.1 and 2.2). */
export const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Impacts that fail the gate. Moderate/minor stay warn-only. */
export const FAILING_IMPACTS = ["critical", "serious"];

const AXE_PACKAGE_DIR = join(TOOL_ROOT, "node_modules", "axe-core");
const AXE_SCRIPT_PATH = join(AXE_PACKAGE_DIR, "axe.min.js");
export const BASELINE_PATH = join(TOOL_ROOT, "a11y-baseline.json");
const A11Y_ARTIFACTS_DIR = "a11y";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readAxeVersion() {
  try {
    return readJson(join(AXE_PACKAGE_DIR, "package.json")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function loadAxeSource() {
  if (!existsSync(AXE_SCRIPT_PATH)) {
    throw new Error(
      `axe-core is not installed at ${AXE_SCRIPT_PATH}; run "npm --prefix tools/web-e2e ci" first`
    );
  }
  return readFileSync(AXE_SCRIPT_PATH, "utf8");
}

/**
 * Load and validate the baseline allowlist. It is intentionally empty unless the
 * Lead approves exceptions; malformed files fail loudly rather than silently
 * passing the audit.
 */
export function loadA11yBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) {
    return { version: 1, exceptions: [], source: null };
  }
  let parsed;
  try {
    parsed = readJson(path);
  } catch (error) {
    throw new Error(`a11y baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.exceptions)) {
    throw new Error("a11y baseline must be an object with an `exceptions` array");
  }
  const exceptions = parsed.exceptions.filter((exception) => {
    const valid = exception !== null
      && typeof exception === "object"
      && typeof exception.rule === "string"
      && exception.rule.length > 0
      && typeof exception.reason === "string"
      && exception.reason.length > 0
      && (exception.state === undefined || typeof exception.state === "string")
      && (exception.selector === undefined || typeof exception.selector === "string");
    if (!valid) {
      throw new Error("a11y baseline exception requires { rule, reason } and optional { state, selector }");
    }
    return true;
  });
  return { version: parsed.version ?? 1, exceptions, source: path };
}

/** Freeze CSS animations/transitions so axe measures the settled UI, not an
 * in-flight reveal/opacity transition (which otherwise produces false
 * low-contrast findings, e.g. marketing `.reveal` fade-ins). */
const ANIMATION_FREEZE_CSS = `
*,
*::before,
*::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  scroll-behavior: auto !important;
}
`;

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function selectorFor(node) {
  // Nodes are already projected by auditPage (selector string); raw axe nodes
  // carry target as an array of cross-frame selectors.
  if (typeof node.selector === "string") return node.selector;
  if (Array.isArray(node.target)) return node.target.join(" ");
  return String(node.target ?? "");
}

/**
 * Inject axe into the current document (once) and run it over `document`.
 * Returns a plain JSON-serializable projection grouped by rule.
 */
export async function auditPage(page, options) {
  const state = options.state;
  const tags = options.tags ?? A11Y_TAGS;
  await page.addStyleTag({ content: ANIMATION_FREEZE_CSS });
  await page.evaluate(
    () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
    })
  );
  const hasAxe = await page.evaluate(() => typeof globalThis.axe !== "undefined");
  if (!hasAxe) {
    await page.addScriptTag({ content: loadAxeSource() });
  }
  const violations = await page.evaluate(async (runTags) => {
    const result = await globalThis.axe.run(document, {
      runOnly: { type: "tag", values: runTags }
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? "unknown",
      help: violation.help,
      description: violation.description,
      helpUrl: violation.helpUrl,
      tags: violation.tags,
      nodeCount: violation.nodes.length,
      nodes: violation.nodes.slice(0, 12).map((node) => ({
        selector: Array.isArray(node.target) ? node.target.join(" ") : String(node.target ?? ""),
        html: (node.html ?? "").slice(0, 200),
        failureSummary: (node.failureSummary ?? "").slice(0, 320)
      }))
    }));
  }, tags);

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
  let nodeCount = 0;
  for (const violation of violations) {
    const impact = FAILING_IMPACTS.includes(violation.impact)
      ? violation.impact
      : violation.impact === "moderate"
        ? "moderate"
        : violation.impact === "minor"
          ? "minor"
          : "unknown";
    counts[impact] += 1;
    nodeCount += violation.nodeCount;
  }
  return {
    state,
    url: options.url ?? page.url(),
    tags,
    counts,
    ruleCount: violations.length,
    nodeCount,
    violations
  };
}

function baselineMatch(violation, state, baseline) {
  return baseline.exceptions.find((exception) => {
    if (exception.rule !== violation.id) return false;
    if (exception.state !== undefined && exception.state !== state) return false;
    if (exception.selector !== undefined) {
      return violation.nodes.some((node) => selectorFor(node).includes(exception.selector));
    }
    return true;
  });
}

/** Aggregate the records, apply the (empty) baseline and decide PASS/FAIL. */
export function evaluateA11yGate(records, baseline) {
  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0, rules: 0, nodes: 0 };
  const failures = [];
  const warnings = [];
  const excepted = [];
  for (const record of records) {
    totals.rules += record.ruleCount;
    totals.nodes += record.nodeCount;
    for (const [impact, count] of Object.entries(record.counts)) {
      totals[impact] = (totals[impact] ?? 0) + count;
    }
    for (const violation of record.violations) {
      if (!FAILING_IMPACTS.includes(violation.impact)) {
        warnings.push({
          state: record.state,
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodeCount: violation.nodeCount,
          selectors: violation.nodes.map((node) => selectorFor(node)).slice(0, 5)
        });
        continue;
      }
      const match = baselineMatch(violation, record.state, baseline);
      if (match !== undefined) {
        excepted.push({
          state: record.state,
          id: violation.id,
          impact: violation.impact,
          reason: match.reason,
          nodeCount: violation.nodeCount
        });
        continue;
      }
      failures.push({
        state: record.state,
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        description: violation.description,
        helpUrl: violation.helpUrl,
        nodeCount: violation.nodeCount,
        selectors: violation.nodes.map((node) => selectorFor(node)).slice(0, 5),
        samples: violation.nodes.slice(0, 2).map((node) => ({
          selector: selectorFor(node),
          failureSummary: node.failureSummary
        }))
      });
    }
  }
  return {
    failed: failures.length > 0,
    failImpacts: [...FAILING_IMPACTS],
    totals,
    failures,
    warnings,
    excepted,
    states: records.length
  };
}

function markdownCell(value) {
  // Markdown table cells: encode `|` as an HTML entity instead of a backslash
  // escape. This keeps the summary readable without any manual escaping /
  // backslash construction (CodeQL js/incomplete-sanitization class).
  return String(value).replace(/\|/gu, "&#124;").replace(/\r?\n/gu, " ");
}

/** Write artifacts/a11y/a11y-report.json and a readable summary markdown. */
export function writeA11yArtifacts(options) {
  const artifactsDir = options.artifactsDir;
  const outDir = join(artifactsDir, A11Y_ARTIFACTS_DIR);
  mkdirSync(outDir, { recursive: true });
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const reportPath = join(outDir, "a11y-report.json");
  const summaryPath = join(outDir, "a11y-summary.md");
  const report = {
    generatedAt,
    axeVersion: options.axeVersion,
    tags: options.tags ?? A11Y_TAGS,
    gate: options.gate,
    baseline: {
      path: options.baseline?.source ?? "tools/web-e2e/a11y-baseline.json",
      exceptions: options.baseline?.exceptions?.length ?? 0
    },
    states: options.records
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const lines = [];
  lines.push("# Accessibility audit (axe-core)");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- axe-core: ${String(options.axeVersion)}`);
  lines.push(`- Tags: ${(options.tags ?? A11Y_TAGS).join(", ")}`);
  lines.push(`- Gate: ${options.gate.failed ? "**FAILED**" : "PASSED"} — fails on ${FAILING_IMPACTS.join("/")} impact only; moderate/minor are warnings.`);
  lines.push(`- Baseline exceptions used: ${options.gate.excepted.length} (file: ${options.baseline?.source ?? "tools/web-e2e/a11y-baseline.json"})`);
  lines.push("");
  lines.push("## Totals (grouped rules per state)");
  lines.push("");
  lines.push("| State | critical | serious | moderate | minor | rules | nodes |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const record of options.records) {
    lines.push(
      `| ${markdownCell(record.state)} | ${record.counts.critical} | ${record.counts.serious} | ${record.counts.moderate} | ${record.counts.minor} | ${record.ruleCount} | ${record.nodeCount} |`
    );
  }
  lines.push(
    `| **total** | **${options.gate.totals.critical}** | **${options.gate.totals.serious}** | **${options.gate.totals.moderate}** | **${options.gate.totals.minor}** | **${options.gate.totals.rules}** | **${options.gate.totals.nodes}** |`
  );
  lines.push("");
  lines.push("## Blocking violations (critical / serious)");
  lines.push("");
  if (options.gate.failures.length === 0) {
    lines.push("No blocking violations.");
  } else {
    for (const failure of options.gate.failures) {
      lines.push(`### ${failure.state} — \`${failure.id}\` (${failure.impact}, ${failure.nodeCount} node(s))`);
      lines.push("");
      lines.push(failure.help);
      if (failure.description !== undefined) lines.push("", failure.description);
      if (failure.selectors.length > 0) {
        lines.push("", `Selectors: ${failure.selectors.map((selector) => `\`${selector}\``).join(", ")}`);
      }
      for (const sample of failure.samples ?? []) {
        if (sample.failureSummary !== "") {
          lines.push("", `- ${sample.selector}: ${truncate(sample.failureSummary, 260)}`);
        }
      }
      lines.push("");
    }
  }
  lines.push("## Non-blocking warnings (moderate / minor)");
  lines.push("");
  if (options.gate.warnings.length === 0) {
    lines.push("None.");
  } else {
    for (const warning of options.gate.warnings) {
      const selectors = warning.selectors.length > 0 ? ` — ${warning.selectors.join(", ")}` : "";
      lines.push(`- ${warning.state}: \`${warning.id}\` (${warning.impact}, ${warning.nodeCount} node(s))${selectors}`);
    }
  }
  lines.push("");
  writeFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  return { reportPath, summaryPath };
}

/** Concise console summary used by the runner. */
export function printA11ySummary(gate) {
  console.log("\n=== Accessibility audit (axe-core, WCAG 2.x A/AA) ===");
  console.log(
    `critical=${gate.totals.critical} serious=${gate.totals.serious} moderate=${gate.totals.moderate} minor=${gate.totals.minor} (${gate.totals.rules} rule/state groups, ${gate.states} states)`
  );
  if (gate.failed) {
    console.log(`A11Y GATE: FAIL — ${gate.failures.length} blocking finding(s) (critical/serious)`);
    for (const failure of gate.failures.slice(0, 25)) {
      console.log(`  FAIL ${failure.state} — ${failure.id} (${failure.impact}) ×${failure.nodeCount}: ${failure.selectors.slice(0, 2).join(", ")}`);
    }
    if (gate.failures.length > 25) console.log(`  … ${gate.failures.length - 25} more in a11y-summary.md`);
  } else {
    console.log("A11Y GATE: PASS — no critical/serious violations");
  }
  const warnGroups = gate.warnings.length;
  if (warnGroups > 0) console.log(`WARN: ${warnGroups} moderate/minor rule group(s) recorded (non-blocking).`);
  if (gate.excepted.length > 0) console.log(`Baseline exceptions applied: ${gate.excepted.length}`);
}
