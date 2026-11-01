import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmActionState,
  confirmMockedState,
  confirmStateEntry,
  buildDiagnosticsSummary,
  buildCaptureMetadata,
  applyPortPlaceholders,
  rewriteUrlPort,
} from "../capture.mjs";

test("confirmMockedState: confirms when all routes hit and no action failure", () => {
  const routes = [{ url: "**/api/tasks" }];
  const res = confirmMockedState("stressed", routes, [1]);
  assert.strictEqual(res.confirmed, true);
  assert.strictEqual(res.observed, "mock:1/1 routes hit");
  assert.strictEqual(res.signal, "mock");
});

test("confirmMockedState: rejects when routes missed", () => {
  const routes = [{ url: "**/api/tasks" }, { url: "**/api/user" }];
  const res = confirmMockedState("stressed", routes, [1, 0]);
  assert.strictEqual(res.confirmed, false);
  assert.deepStrictEqual(res.missed_routes, ["**/api/user"]);
});

test("confirmMockedState: rejects when routes hit BUT action failed (P1 action integrity)", () => {
  const routes = [{ url: "**/api/tasks" }];
  const res = confirmMockedState("modal", routes, [1], {
    actionError: "page.waitForSelector: Timeout 5000ms exceeded waiting for locator('button')",
  });
  assert.strictEqual(res.confirmed, false);
  assert.match(res.observed, /action_failed/);
  assert.strictEqual(res.action_error, "page.waitForSelector: Timeout 5000ms exceeded waiting for locator('button')");
});

test("confirmStateEntry: rejects when action failed even if DOM text matches", () => {
  const dom = { appliedRootState: "modal", domText: "modal" };
  const res = confirmStateEntry("modal", dom, {
    actionError: "element not clickable",
  });
  assert.strictEqual(res.confirmed, false);
  assert.match(res.observed, /action_failed/);
});

test("buildDiagnosticsSummary: passes clean page with CHI 100", () => {
  const blank = {
    scrollWidth: 1280,
    clientWidth: 1280,
    horizontal_overflow: false,
    stylesheets_applied: true,
    has_active_feedback: true,
    active_feedback_coverage: { covered: 5, total: 5 },
    has_tabular_nums: true,
    button_text_wrap_count: 0,
    low_contrast_count: 0,
    cls_score: 0,
    unlabeled_control_count: 0,
    missing_autocomplete_count: 0,
    th_without_scope_count: 0,
    numeric_cell_misaligned_count: 0,
    small_touch_target_count: 0,
    small_touch_targets: [],
    dom_metrics: "full",
  };
  const res = buildDiagnosticsSummary({
    runner: "playwright-concurrent",
    status: "captured",
    captures: { "default-1280": "default-1280.png" },
    viewport_metrics: { "default-1280": blank },
    runtime_errors: [],
    failures: [],
  });
  assert.strictEqual(res.craft_health_index.score, 100);
  assert.strictEqual(res.craft_gate.passed, true);
});

test("buildDiagnosticsSummary: P0 fail-closed on page runtime crashes / blank page", () => {
  const blank = {
    scrollWidth: 1280,
    clientWidth: 1280,
    horizontal_overflow: false,
    stylesheets_applied: true,
    has_active_feedback: null,
    active_feedback_coverage: { covered: 0, total: 0 },
    has_tabular_nums: true,
    button_text_wrap_count: 0,
    low_contrast_count: 0,
    cls_score: 0,
    unlabeled_control_count: 0,
    missing_autocomplete_count: 0,
    th_without_scope_count: 0,
    numeric_cell_misaligned_count: 0,
    small_touch_target_count: 0,
    small_touch_targets: [],
    dom_metrics: "full",
  };
  const res = buildDiagnosticsSummary({
    runner: "playwright-concurrent",
    status: "captured",
    viewport_metrics: { "default-1280": blank },
    runtime_errors: ["[default-1280] Cannot read properties of undefined (reading 'length')"],
    failures: [],
  });
  // Must fail closed: gate fails and score collapses to 0 Grade F
  assert.strictEqual(res.craft_gate.passed, false);
  assert.match(res.craft_gate.reason, /runtime_errors detected/);
  assert.strictEqual(res.craft_health_index.score, 0);
  assert.strictEqual(res.craft_health_index.grade, "F");
  assert.strictEqual(res.craft_health_index.deductions[0].rule, "runtime_crash");
});

test("buildDiagnosticsSummary: P2 CLS smooth scoring does not penalize negligible shift", () => {
  const base = {
    scrollWidth: 1280,
    clientWidth: 1280,
    horizontal_overflow: false,
    stylesheets_applied: true,
    has_active_feedback: true,
    active_feedback_coverage: { covered: 5, total: 5 },
    has_tabular_nums: true,
    button_text_wrap_count: 0,
    low_contrast_count: 0,
    cls_score: 0.0004, // negligible CLS < 0.05
    unlabeled_control_count: 0,
    missing_autocomplete_count: 0,
    th_without_scope_count: 0,
    numeric_cell_misaligned_count: 0,
    small_touch_target_count: 0,
    small_touch_targets: [],
    dom_metrics: "full",
  };
  const res = buildDiagnosticsSummary({
    runner: "playwright-concurrent",
    status: "captured",
    captures: { "default-1280": "default-1280.png" },
    viewport_metrics: { "default-1280": base },
    runtime_errors: [],
    failures: [],
  });
  assert.strictEqual(res.craft_health_index.score, 100);
  assert.strictEqual(res.craft_health_index.deductions.length, 0);
  assert.strictEqual(res.craft_gate.passed, true);
});

test("buildDiagnosticsSummary: P2 deduplicates same controls across multiple states", () => {
  const makeVp = () => ({
    scrollWidth: 1280,
    clientWidth: 1280,
    horizontal_overflow: false,
    stylesheets_applied: true,
    has_active_feedback: true,
    active_feedback_coverage: { covered: 5, total: 5 },
    has_tabular_nums: true,
    button_text_wrap_count: 0,
    low_contrast_count: 0,
    cls_score: 0,
    unlabeled_control_count: 0,
    missing_autocomplete_count: 0,
    th_without_scope_count: 0,
    numeric_cell_misaligned_count: 0,
    small_touch_target_count: 2,
    small_touch_targets: [
      { tag: "button", label: "刷新", width: 20, height: 20 },
      { tag: "button", label: "重置", width: 22, height: 22 },
    ],
    dom_metrics: "full",
  });
  // 10 states repeating the SAME 2 buttons
  const viewport_metrics = {};
  for (let i = 0; i < 10; i++) {
    viewport_metrics[`state-${i}-1280`] = makeVp();
  }
  const res = buildDiagnosticsSummary({
    runner: "playwright-concurrent",
    status: "captured",
    captures: Object.fromEntries(Object.keys(viewport_metrics).map((k) => [k, `${k}.png`])),
    viewport_metrics,
    runtime_errors: [],
    failures: [],
  });
  const touchDeduction = res.craft_health_index.deductions.find((d) => d.rule === "touch_target_size");
  assert.ok(touchDeduction);
  // 2 unique controls * 3 points = 6 points, NOT 20 occurrences * 3 = 15 ceiling
  assert.strictEqual(touchDeduction.points, 6);
  assert.strictEqual(res.craft_health_index.score, 94);
});

test("buildCaptureMetadata: P1 craft_gate persisted into manifest evidence and validation", () => {
  const result = {
    runner: "playwright-concurrent",
    status: "captured",
    captures: { "default-1280": "default-1280.png" },
    viewport_metrics: {},
    runtime_errors: [],
    failures: [],
  };
  const diagnostics_summary = {
    craft_health_index: { score: 95, grade: "A+" },
    craft_gate: { threshold: 90, passed: true, score: 95, reason: "healthy" },
  };
  const metadata = buildCaptureMetadata(result, { diagnostics_summary });
  assert.ok(metadata.evidence.craft_gate, "evidence.craft_gate must exist");
  assert.strictEqual(metadata.evidence.craft_gate.passed, true);
  assert.ok(metadata.validation.craft_gate, "validation.craft_gate must exist");
  assert.strictEqual(metadata.validation.craft_gate.passed, true);
});

test("confirmActionState: confirms when every declared action executed", () => {
  const res = confirmActionState("modal", [{ click: "[data-modal-trigger]" }]);
  assert.strictEqual(res.confirmed, true);
  assert.strictEqual(res.signal, "actions");
  assert.strictEqual(res.observed, "actions:1/1 executed");
});

test("confirmActionState: rejects on failed action even though the modal may be open", () => {
  const res = confirmActionState("modal", [{ click: "[data-modal-trigger]" }], {
    actionError: "Timeout 5000ms exceeded",
  });
  assert.strictEqual(res.confirmed, false);
  assert.match(res.observed, /action_failed/);
});

test("confirmActionState: rejects a state with no actions declared", () => {
  assert.strictEqual(confirmActionState("modal", []).confirmed, false);
});

test("P0 gate: zero screenshots can never score CHI 100 or pass", () => {
  const res = buildDiagnosticsSummary({
    runner: "playwright-concurrent",
    status: "capture_failed",
    captures: {},
    viewport_metrics: {},
    runtime_errors: [],
    failures: [{ state: "default", viewport: "1280", error: "state_unconfirmed" }],
  });
  assert.strictEqual(res.craft_gate.passed, false);
  assert.strictEqual(res.craft_health_index.score, 0);
  assert.match(res.craft_gate.reason, /no_screenshots/);
});

test("P0 gate: capture_failed with screenshots still fails closed", () => {
  const base = {
    scrollWidth: 1280, clientWidth: 1280, horizontal_overflow: false,
    stylesheets_applied: true, has_active_feedback: true,
    active_feedback_coverage: { covered: 5, total: 5 }, has_tabular_nums: true,
    button_text_wrap_count: 0, low_contrast_count: 0, cls_score: 0,
    unlabeled_control_count: 0, missing_autocomplete_count: 0,
    th_without_scope_count: 0, numeric_cell_misaligned_count: 0,
    small_touch_target_count: 0, small_touch_targets: [], dom_metrics: "full",
  };
  const res = buildDiagnosticsSummary({
    runner: "playwright-concurrent",
    status: "capture_failed",
    captures: { "default-1280": "default-1280.png" },
    viewport_metrics: { "default-1280": base },
    runtime_errors: [],
    failures: [],
    state_confirmations: { "default-1280": { expected: "default", observed: "none", confirmed: false } },
  });
  assert.strictEqual(res.craft_gate.passed, false);
  assert.match(res.craft_gate.reason, /capture_incomplete/);
  assert.strictEqual(res.craft_gate.evidence_complete, false);
  assert.strictEqual(res.craft_gate.unconfirmed_states, 1);
});

test("P0 gate: unmeasured CLI probes cannot pass even when the capture status is clean", () => {
  const res = buildDiagnosticsSummary({
    runner: "system-browser-cli-concurrent",
    status: "captured",
    captures: { "1280": "1280.png" },
    viewport_metrics: { "1280": { dom_metrics: "unmeasured_cli_runner" } },
    runtime_errors: [],
    failures: [],
  });
  assert.strictEqual(res.craft_gate.passed, false);
  assert.match(res.craft_gate.reason, /probe_unmeasured/);
});

test("P2 aesthetic probes deduct for overlong measure, flat scale, nested cards", () => {
  const metrics = {
    scrollWidth: 1280, clientWidth: 1280, horizontal_overflow: false,
    stylesheets_applied: true, has_active_feedback: true,
    active_feedback_coverage: { covered: 5, total: 5 }, has_tabular_nums: true,
    button_text_wrap_count: 0, low_contrast_count: 0, cls_score: 0,
    unlabeled_control_count: 0, missing_autocomplete_count: 0,
    th_without_scope_count: 0, numeric_cell_misaligned_count: 0,
    small_touch_target_count: 0, small_touch_targets: [], dom_metrics: "full",
    measure_violation_count: 2,
    heading_scale_flat: true,
    nested_cards: [{ tag: "div", depth: 3 }],
    orphan_heading_count: 1,
    orphan_headings: [{ text: "Pricing" }],
  };
  const res = buildDiagnosticsSummary({
    runner: "playwright-concurrent",
    status: "captured",
    captures: { "default-1280": "default-1280.png" },
    viewport_metrics: { "default-1280": metrics },
    runtime_errors: [],
    failures: [],
  });
  const rules = res.craft_health_index.deductions.map((d) => d.rule);
  assert.ok(rules.includes("measure_width"));
  assert.ok(rules.includes("type_scale"));
  assert.ok(rules.includes("nested_cards"));
  assert.ok(rules.includes("orphan_heading"));
  assert.strictEqual(res.craft_gate.passed, false);
});

test("applyPortPlaceholders: only documented placeholders are substituted", () => {
  assert.strictEqual(applyPortPlaceholders("vite --port {port}", 5173), "vite --port 5173");
  assert.strictEqual(applyPortPlaceholders("npm run preview -- --port $PORT", 5173), "npm run preview -- --port 5173");
  assert.strictEqual(applyPortPlaceholders("EXPORT=1 REPORT=x", 5173), "EXPORT=1 REPORT=x");
});

test("rewriteUrlPort: fixed URL follows the auto-allocated port", () => {
  assert.strictEqual(rewriteUrlPort("http://localhost:3000/app?x=1", 5173), "http://localhost:5173/app?x=1");
});
