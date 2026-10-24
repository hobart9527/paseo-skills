#!/usr/bin/env node
// Headless multi-viewport and multi-state screenshot capture for spec-prototype evidence.
// Uses local Playwright/Puppeteer or system Chrome/Edge. Zero extra dependencies.
//
// Usage: node capture.mjs <url> --out <dir> [--viewports 320,390,768,1280] [--states ideal,error,skeleton]

import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pExecFile = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VIEWPORT_PRESETS = {
  "320": { width: 320, height: 640 },
  "390": { width: 390, height: 844 },
  "768": { width: 768, height: 1024 },
  "1280": { width: 1280, height: 800 },
};

async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function findSystemBrowser() {
  const candidates = [
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try PATH
  for (const bin of ["google-chrome", "chromium", "chromium-browser", "msedge"]) {
    const res = spawnSync("which", [bin], { encoding: "utf-8" });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  }
  return null;
}

export function buildVariantUrl(baseUrl, state, scheme, density) {
  const hashIdx = baseUrl.indexOf("#");
  const clean = hashIdx !== -1 ? baseUrl.slice(0, hashIdx) : baseUrl;
  const sep = clean.includes("?") ? "&" : "?";
  const params = new URLSearchParams();
  if (state && state !== "default") params.set("state", state);
  params.set("theme", scheme);
  if (density) params.set("density", density);
  return `${clean}${sep}${params.toString()}`;
}

// State-entry confirmation (CRAFT-STATE-ENTRY). Precedence for the applied
// signal: body[data-state] → html[data-state] → outermost applied [data-state]
// root (prototypes commonly keep live state on the app shell, e.g.
// #app[data-state]; the contract counts that as the applied signal), then the
// ?state= URL echo. The echo alone is a weaker signal (a router may ignore the
// param), so it confirms only when the visible DOM text independently contains
// the state name. Pure so the truth table is testable without a browser.
export function confirmStateEntry(expectedState, dom) {
  const raw = dom.bodyState || dom.htmlState || dom.appliedRootState || "";
  const urlEcho = dom.urlEcho || "";
  const domEcho = expectedState !== "default" && (dom.domText || "").includes(expectedState);
  const declared = raw || urlEcho;
  return {
    expected: expectedState,
    observed: declared,
    confirmed: expectedState === "default"
      ? declared === "default" || declared === ""
      : raw === expectedState || (urlEcho === expectedState && domEcho),
  };
}

// Requested-vs-actual reconciliation. The page reports only what it observed;
// the request is only a request. A preference the engine did not apply — or a
// rendition the page never acknowledged — is `null` (unmeasured), never the
// request echoed back as though it had been verified. Pure so the rule is
// testable without a browser.
export function resolveAppliedPreferences(requested = {}, observed = {}) {
  const scheme = requested.scheme || null;
  const density = requested.density || null;
  const contrast = requested.contrast && requested.contrast !== "no-preference"
    ? requested.contrast : null;
  const forcedColors = requested.forcedColors === "active" ? "active" : null;

  return {
    prefers_contrast: contrast && observed.prefers_contrast !== contrast
      ? null : (observed.prefers_contrast ?? null),
    forced_colors: forcedColors && observed.forced_colors !== forcedColors
      ? null : (observed.forced_colors ?? null),
    theme_applied: observed.theme && (!scheme || observed.theme === scheme) ? observed.theme : null,
    density_applied: observed.density && (!density || observed.density === density) ? observed.density : null,
  };
}

async function loadPlaywright() {
  // Local node_modules first, then global installs (npm -g), which ESM import
  // cannot reach without an explicit resolution attempt.
  try {
    return await import("playwright");
  } catch {}
  try {
    const { createRequire } = await import("node:module");
    const { execFileSync } = await import("node:child_process");
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const req = createRequire(`${globalRoot}/`);
    const playwrightPath = req.resolve("playwright");
    const mod = await import(playwrightPath);
    // Global-install CJS interop exposes the namespace on .default.
    return mod.chromium ? mod : (mod.default ?? null);
  } catch {}
  return null;
}

async function captureWithPlaywright(baseUrl, outputDir, viewports, states, schemes = ["light"], density = null,
                                     forcedColors = "none", contrast = "no-preference", concurrency = 4) {
  try {
    const pw = await loadPlaywright();
    if (!pw) return null;
    const { chromium } = pw;
    const browser = await chromium.launch({
      headless: true,
      args: ["--allow-file-access-from-files"],
    });
    const captured = {};
    const failures = [];
    const runtimeErrors = [];
    const viewportMetrics = {};
    const stateConfirmations = {};

    const tasks = [];
    const multiState = states.length > 1;
    const multiScheme = schemes.length > 1;
    // Scheme is the outer loop so the first capture of each viewport is the light
    // one: `default` screenshots and downstream first-impression judges read the
    // light rendition, and dark is an additional measured rendition, not a swap.
    for (const scheme of schemes) {
      for (const state of states) {
        const stateUrl = buildVariantUrl(baseUrl, state, scheme, density);
        for (const vp of viewports) {
          // `state-vp` (legacy), `scheme-vp`, or `state-scheme-vp` when both vary.
          const prefix = [multiState ? state : null, multiScheme ? scheme : null, vp]
            .filter(Boolean).join("-");
          const targetFile = path.join(outputDir, `${prefix}.png`);
          const dim = VIEWPORT_PRESETS[vp] || { width: parseInt(vp, 10) || 1280, height: 800 };
          tasks.push({ state, scheme, vp, prefix, targetFile, dim, stateUrl });
        }
      }
    }

    await mapConcurrent(tasks, concurrency, async ({ state, scheme, vp, prefix, targetFile, dim, stateUrl }) => {
      try {
        const page = await browser.newPage({ viewport: dim, colorScheme: scheme });
        // Emulated preferences are declared to the page, not merely rendered: a
        // `prefers-contrast` or `forced-colors` stylesheet is only exercised when
        // the engine actually reports the media feature as matching.
        await page.emulateMedia({ colorScheme: scheme, forcedColors, contrast });
        page.on("pageerror", (err) => runtimeErrors.push(`[${prefix}] ${err.message}`));
        const failedUrls = [];
        page.on("requestfailed", (req) => failedUrls.push(req.url()));
        page.on("response", (res) => {
          if (res.status() >= 400) failedUrls.push(res.url());
        });
        await page.goto(stateUrl, { waitUntil: "networkidle", timeout: 15000 });
        // Collect DOM facts in-page, decide in Node: page.evaluate cannot see
        // module-scope exports, and keeping the decision in confirmStateEntry
        // makes its truth table testable without a browser. body/html
        // data-state win when present; an applied [data-state] on an app
        // shell (e.g. #app) counts too — the contract allows any mount point.
        // The URL echo stays a weaker signal: it confirms only when the state
        // name also appears verbatim in visible DOM text.
        const domFacts = await page.evaluate(() => ({
          bodyState: document.body?.dataset.state || "",
          htmlState: document.documentElement.dataset.state || "",
          appliedRootState: document.querySelector("[data-state]")?.dataset.state || "",
          urlEcho: new URLSearchParams(location.search).get("state") ||
            (location.hash.match(/state=([a-z0-9_-]+)/i)?.[1] ?? ""),
          domText: document.body?.innerText || "",
        }));
        const stateConfirmation = confirmStateEntry(state, domFacts);
        stateConfirmations[prefix] = stateConfirmation;
        if (!stateConfirmation.confirmed) {
          throw new Error(`state_unconfirmed: expected ${state}, observed ${stateConfirmation.observed || "none"}`);
        }
        // Viewport containment evidence: record horizontal overflow at capture
        // time so a scrollWidth > clientWidth break surfaces in the same pass
        // as the screenshot instead of only at downstream task judging.
        const metrics = await page.evaluate((failed) => {
          const de = document.documentElement;
          const smallTargets = [];
          // Record every interactive control below the task judge's default
          // 44px touch-target floor; WCAG exceptions require independent review.
          const isInteractive = (el) => Boolean(el.closest("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=checkbox], [role=switch], [role=radio], summary"));
          for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab], summary")) {
            if (!isInteractive(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const inlineException = el.hasAttribute("data-inline-target-exception");
            if ((r.width < 44 || r.height < 44) && !inlineException) {
              smallTargets.push({
                tag: el.tagName.toLowerCase(),
                label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
                width: Math.round(r.width),
                height: Math.round(r.height),
              });
            }
          }

          const failedSet = new Set(failed || []);
          let hasActiveRule = false;
          let stylesheetsApplied = false;
          let stylesheetsUnmeasured = false;
          try {
            for (const sheet of document.styleSheets) {
              const isFailed = sheet.href && failedSet.has(sheet.href);
              if (isFailed) {
                stylesheetsUnmeasured = true;
                continue;
              }
              try {
                if (sheet.cssRules && sheet.cssRules.length > 0) {
                  stylesheetsApplied = true;
                  for (const rule of sheet.cssRules) {
                    if (rule.selectorText && rule.selectorText.includes(":active")) {
                      hasActiveRule = true;
                    }
                  }
                }
              } catch (e) {
                // A successful cross-origin response may be applied, but its
                // inaccessible rules cannot prove application or absence.
                if (e.name === "SecurityError") stylesheetsUnmeasured = true;
              }
            }
          } catch {
            stylesheetsUnmeasured = true;
          }
          if (stylesheetsUnmeasured) stylesheetsApplied = null;

          let hasTabularNums = false;
          for (const el of document.querySelectorAll("td, th, span, div, p, code")) {
            const text = el.textContent || "";
            if (/\d/.test(text)) {
              const comp = window.getComputedStyle(el);
              if (comp.fontVariantNumeric && comp.fontVariantNumeric.includes("tabular-nums")) {
                hasTabularNums = true;
                break;
              }
              if (comp.fontFeatureSettings && (comp.fontFeatureSettings.includes("tnum") || comp.fontFeatureSettings.includes('"tnum" 1'))) {
                hasTabularNums = true;
                break;
              }
            }
          }

          const hasOverflow = de.scrollWidth > de.clientWidth + 1;

          // Document-level signals that no single element carries. `null` here
          // means unmeasured, which the collector reports distinctly from false.
          const heading = document.querySelector("h1, h2, h3");
          const titleWrap = heading
            ? /balance|pretty/.test(window.getComputedStyle(heading).textWrap || "")
            : null;
          const fontsStatus = (document.fonts && document.fonts.status)
            ? (document.fonts.status === "loaded")
            : null;

          // Raw observations only. Whether a requested preference was actually
          // applied is decided outside the page by `resolveAppliedPreferences`,
          // which compares these against the request — the query string is the
          // request and proves nothing about what rendered.
          const observedTheme = document.documentElement.getAttribute("data-theme") ||
            document.body?.dataset.theme || null;
          const observedDensity = document.documentElement.getAttribute("data-density") ||
            document.body?.dataset.density || null;
          const observedContrast = ["more", "less", "custom"]
            .find((q) => window.matchMedia(`(prefers-contrast: ${q})`).matches) || "no-preference";
          const observedForced = window.matchMedia("(forced-colors: active)").matches ? "active" : "none";

          return {
            scrollWidth: de.scrollWidth,
            clientWidth: de.clientWidth,
            scrollHeight: de.scrollHeight,
            clientHeight: de.clientHeight,
            horizontal_overflow: hasOverflow,
            stylesheets_applied: stylesheetsApplied,
            has_active_feedback: hasActiveRule,
            has_tabular_nums: hasTabularNums,
            small_touch_targets: smallTargets.slice(0, 10),
            small_touch_target_count: smallTargets.length,
            dialog_present: Boolean(document.querySelector("dialog")),
            dialog_showmodal_bound: /showModal/.test(document.documentElement.outerHTML),
            lang: document.documentElement.getAttribute("lang") || null,
            heading_text_wrap: titleWrap,
            fonts_loaded: fontsStatus,
            prefers_contrast: observedContrast,
            forced_colors: observedForced,
            theme_observed: observedTheme,
            density_observed: observedDensity,
          };
        }, failedUrls);
        Object.assign(metrics, resolveAppliedPreferences(
          { scheme, density, contrast, forcedColors },
          {
            theme: metrics.theme_observed,
            density: metrics.density_observed,
            prefers_contrast: metrics.prefers_contrast,
            forced_colors: metrics.forced_colors,
          },
        ));
        viewportMetrics[prefix] = metrics;
        await page.screenshot({ path: targetFile, fullPage: false });
        await page.close();
        if (states.length > 1 && (state === "ideal" || state === states[0])) {
          const defaultTarget = path.join(outputDir, `${vp}.png`);
          if (!fs.existsSync(defaultTarget)) fs.copyFileSync(targetFile, defaultTarget);
        }
        captured[prefix] = targetFile;
      } catch (error) {
        failures.push({ state, viewport: vp, error: error instanceof Error ? error.message : String(error) });
      }
    });

    await browser.close();
    const vps = {};
    for (const [k, v] of Object.entries(captured)) {
      const vp = k.split("-").pop();
      if (!vps[vp]) vps[vp] = v;
    }
    return {
      status: failures.length ? "capture_failed" : "captured",
      runner: "playwright-concurrent",
      viewports: vps,
      captures: captured,
      viewport_metrics: viewportMetrics,
      state_confirmations: stateConfirmations,
      runtime_errors: runtimeErrors,
      failures: [
        ...failures,
        ...Object.entries(stateConfirmations)
          .filter(([, confirmation]) => !confirmation.confirmed)
          .map(([prefix, confirmation]) => ({
            state: confirmation.expected,
            viewport: prefix.split("-").pop(),
            error: `state_unconfirmed: expected ${confirmation.expected}, observed ${confirmation.observed || "none"}`,
          })),
      ],
    };
  } catch {
    return null;
  }
}

async function captureWithCli(browserBin, baseUrl, outputDir, viewports, states, schemes = ["light"], density = null,
                              concurrency = 4) {
  const captured = {};
  const tasks = [];

  const multiState = states.length > 1;
  const multiScheme = schemes.length > 1;
  for (const scheme of schemes) {
    for (const state of states) {
      const stateUrl = buildVariantUrl(baseUrl, state, scheme, density);
      for (const vp of viewports) {
        const dim = VIEWPORT_PRESETS[vp] || { width: parseInt(vp, 10) || 1280, height: 800 };
        const prefix = [multiState ? state : null, multiScheme ? scheme : null, vp]
          .filter(Boolean).join("-");
        const targetFile = path.join(outputDir, `${prefix}.png`);
        tasks.push({ state, scheme, vp, dim, prefix, targetFile, stateUrl });
      }
    }
  }

  await mapConcurrent(tasks, concurrency, async ({ state, vp, dim, prefix, targetFile, stateUrl }) => {
    try {
      await pExecFile(
        browserBin,
        [
          "--headless",
          "--allow-file-access-from-files",
          "--disable-gpu",
          "--disable-extensions",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-sync",
          "--hide-scrollbars",
          "--mute-audio",
          `--window-size=${dim.width},${dim.height}`,
          `--screenshot=${targetFile}`,
          stateUrl,
        ],
        { timeout: 15000 }
      );
      if (fs.existsSync(targetFile)) {
        captured[prefix] = targetFile;
        if (states.length > 1 && (state === "ideal" || state === states[0])) {
          const defaultTarget = path.join(outputDir, `${vp}.png`);
          if (!fs.existsSync(defaultTarget)) {
            try { fs.copyFileSync(targetFile, defaultTarget); } catch {}
          }
        }
      }
    } catch {
      // continue with remaining tasks
    }
  });

  if (Object.keys(captured).length > 0) {
    const vps = {};
    for (const [k, v] of Object.entries(captured)) {
      const vp = k.split("-").pop();
      if (!vps[vp]) vps[vp] = v;
    }
    // The CLI screenshot path cannot evaluate page DOM: containment and
    // touch-target metrics stay explicitly unmeasured rather than absent
    // (absent would read as "measured clean" downstream).
    const viewportMetrics = Object.fromEntries(
      Object.keys(captured).map((prefix) => [prefix, { dom_metrics: "unmeasured_cli_runner" }])
    );
    return {
      status: states.length > 1 ? "capture_failed" : "captured",
      runner: "system-browser-cli-concurrent",
      viewports: vps,
      captures: captured,
      viewport_metrics: viewportMetrics,
      unconfirmed_states: states.length > 1
        ? states.filter((state) => state !== "default").map((state) => `${state}: state confirmation unavailable in CLI runner`)
        : [],
    };
  }
  return null;
}

// ---- Revision-specific evidence binding (pure seam) ----------------------
// Binds captured pixels to the environment, target and dependency identity that
// produced them. Native-platform validation is never inferred from the runner,
// the requested viewport list or a target-platform label: only an actual run on
// that platform may claim it.

const BROWSER_EXECUTION_BY_RUNNER = {
  "playwright-concurrent": "html-browser",
  "system-browser-cli-concurrent": "html-browser",
};

function normalizeDependencies(dependencies) {
  return (Array.isArray(dependencies) ? dependencies : [])
    .map((entry) => (typeof entry === "string" ? { ref: entry, digest: null } : entry || {}))
    .filter((entry) => typeof entry.ref === "string" && entry.ref.length > 0)
    .map((entry) => ({ ref: entry.ref, digest: entry.digest == null ? null : String(entry.digest) }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

export function buildCaptureMetadata(result, options = {}) {
  const capture = result && typeof result === "object" ? result : {};
  const {
    targetPath = null,
    targetUri = null,
    targetPlatform = "web",
    runtime = "unknown",
    sourceRevision = "unversioned",
    dependencies = [],
  } = options;

  const captures = capture.captures || {};
  const failures = Array.isArray(capture.failures) ? capture.failures : [];
  const runtimeErrors = Array.isArray(capture.runtime_errors) ? capture.runtime_errors : [];
  const viewportMetrics = capture.viewport_metrics || {};
  // Horizontal overflow at any captured viewport is a containment break, not a
  // capture failure: surface it as an explicit finding on the metadata record.
  const overflowFindings = Object.entries(viewportMetrics)
    .filter(([, m]) => m && typeof m.scrollWidth === "number" && typeof m.clientWidth === "number"
      && m.scrollWidth > m.clientWidth + 1)
    .map(([prefix, m]) => `${prefix}: scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}`);
  // Touch-target findings mirror the task judge's min_touch_target check so a
  // small-control break surfaces at capture time, not only at judging.
  const touchFindings = Object.entries(viewportMetrics)
    .filter(([, m]) => m && typeof m.small_touch_target_count === "number" && m.small_touch_target_count > 0)
    .map(([prefix, m]) => `${prefix}: ${m.small_touch_target_count} control(s) under 44px min target`);
  const stateConfirmations = capture.state_confirmations || {};
  const unconfirmedStates = [
    ...Object.entries(stateConfirmations)
      .filter(([, confirmation]) => !confirmation || confirmation.confirmed !== true)
      .map(([prefix, confirmation]) => `${prefix}: expected ${confirmation?.expected || "unknown"}, observed ${confirmation?.observed || "none"}`),
    ...(capture.unconfirmed_states || []),
  ];
  const screenshotCount = Object.keys(captures).length;
  const measurementTier = capture.runner === "system-browser-cli-concurrent" ? "cli" : "playwright";
  const triState = aggregateTriState(viewportMetrics, measurementTier);
  const browserExecution = BROWSER_EXECUTION_BY_RUNNER[capture.runner] || "unavailable";
  const status = typeof capture.status === "string" ? capture.status : "browser_unavailable";
  const captured = status === "captured" && screenshotCount > 0 && unconfirmedStates.length === 0;

  let evidenceKind;
  if (screenshotCount === 0) evidenceKind = "none";
  else if (captured && runtimeErrors.length === 0 && failures.length === 0) evidenceKind = "rendered";
  else evidenceKind = "screenshot-only";

  const depList = normalizeDependencies(dependencies);
  const dependencySignature = depList.map((d) => `${d.ref}=${d.digest ?? "-"}`).join(",");
  const identity = [
    `target:${targetPath ?? targetUri ?? "unknown"}`,
    `source:${sourceRevision}`,
    `deps:${dependencySignature}`,
  ].join("|");

  const evidenceFailures = [...failures, ...unconfirmedStates.map((message) => ({ state: "unconfirmed", viewport: null, error: message }))];
  const evidenceRuntimeErrors = unconfirmedStates.length > 0
    ? [...runtimeErrors, ...unconfirmedStates.map((message) => `state_confirmation: ${message}`)]
    : runtimeErrors;

  return {
    schema: "loom.capture-metadata.v1",
    status,
    identity,
    environment: {
      runtime,
      browser_execution: browserExecution,
      runner: capture.runner || null,
      ...triState,
    },
    target: { platform: targetPlatform, path: targetPath, uri: targetUri },
    source: { revision: sourceRevision },
    evidence: {
      kind: evidenceKind,
      screenshots: screenshotCount,
      direction_contract_checklist: [
        "THESIS: Does the primary view resolve the authentic product tension?",
        "OWN-WORLD: Is the sensory vocabulary distinct and appropriate for this lifeworld?",
        "STORY: Is the end-to-end journey visible and navigable from the canvas?",
        "FIRST VIEWPORT: Is the initial fold immediately legible with zero cognitive friction?",
        "FORM: Does the layout geometry match the OOUX cardinality (1:1, 1:N, N:M)?",
        "FINISH: Are the craft floors (press feedback, tabular numbers, concentric radii) delivered?"
      ],
      paths: Object.values(captures),
      runtime_errors: evidenceRuntimeErrors,
      failures: evidenceFailures,
      unconfirmed_states: unconfirmedStates,
      state_confirmations: stateConfirmations,
      viewport_metrics: viewportMetrics,
      requested_preferences: options.requested || {},
      // Re-asked through the same rule the capture used, so a reader never sees
      // the request listed as though the page had confirmed it. `theme_observed`
      // falls back to the resolved value for metrics recorded before this seam.
      applied_preferences: Object.fromEntries(
        Object.entries(viewportMetrics).map(([key, metrics]) => {
          const request = options.requested || {};
          const resolved = resolveAppliedPreferences(
            { scheme: (request.schemes || [])[0] || null, density: request.density,
              contrast: request.contrast, forcedColors: request.forcedColors },
            { theme: metrics?.theme_observed ?? metrics?.theme_applied ?? null,
              density: metrics?.density_observed ?? metrics?.density_applied ?? null,
              prefers_contrast: metrics?.prefers_contrast ?? null,
              forced_colors: metrics?.forced_colors ?? null },
          );
          return [key, { prefers_contrast: resolved.prefers_contrast,
                         forced_colors: resolved.forced_colors,
                         theme: resolved.theme_applied, density: resolved.density_applied }];
        }),
      ),
      horizontal_overflow: overflowFindings,
      small_touch_targets: touchFindings,
      dom_metrics_coverage: Object.values(viewportMetrics).some((m) => m && m.dom_metrics === "unmeasured_cli_runner")
        ? "partial: CLI runner cannot evaluate DOM; containment/touch findings above are Playwright-only"
        : "full",
      ...triState,
    },
    validation: {
      kind: "renderer_capture",
      claim: captured ? "renderer_screenshots_pending_review" : "capture_failed",
      // Hard-coded false: a browser render can never be native-platform validation.
      native_platform_validation: false,
      human: "pending_review",
      visual: "pending_review",
    },
    dependencies: depList,
  };
}

export function mergeVerification(previous, metadata) {
  const prev = previous && typeof previous === "object" ? previous : {};
  // Inherited human/visual status survives only while the bound identity is
  // unchanged; any target, source or dependency change resets it to pending.
  const sameIdentity = typeof prev.identity === "string" && prev.identity === metadata.identity;
  const carried = (field) => (sameIdentity ? prev[field] || "pending_review" : "pending_review");
  // A multi-viewport run merges per-viewport evidence: an added viewport must
  // not drop the viewports already captured under the same identity. The
  // re-merged metadata keeps every prior path/metric/state and lets the new run
  // override the same keys.
  const merged = sameIdentity ? mergeEvidence(prev.metadata, metadata) : metadata;
  const vpKeys = Object.keys(merged.evidence ? merged.evidence.viewport_metrics || {} : {});
  return {
    status: "captured_pending_review",
    renderer: "captured",
    browser: "captured",
    visual: carried("visual"),
    human: carried("human"),
    identity: metadata.identity,
    identity_changed: !sameIdentity,
    evidence: `Capture ${metadata.status} (${metadata.evidence.kind}; ${metadata.evidence.screenshots} screenshot(s)${
      vpKeys.length > 0 ? `, ${vpKeys.join(", ")}px` : ""
    }) on ${metadata.environment.browser_execution}/${metadata.environment.runtime}; pending visual & experience critique`,
    timestamp: new Date().toISOString(),
    runner: metadata.environment.runner || "browser-capture",
    metadata: merged,
  };
}

// Union per-viewport evidence for a re-capture under an unchanged identity.
// Captures, failures and runtime errors accumulate by key; viewport metrics and
// state confirmations merge with the new run winning on shared keys; the derived
// overflow/touch findings and screenshot count are recomputed from the union so
// a second viewport never reports the first as missing.
function mergeEvidence(prevMeta, nextMeta) {
  const prev = prevMeta && typeof prevMeta === "object" ? prevMeta : {};
  const prevEv = prev.evidence && typeof prev.evidence === "object" ? prev.evidence : {};
  const nextEv = nextMeta.evidence && typeof nextMeta.evidence === "object" ? nextMeta.evidence : {};
  const unionObj = (a, b) => ({ ...(a && typeof a === "object" ? a : {}), ...(b && typeof b === "object" ? b : {}) });
  const unionList = (a, b) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  const paths = [...new Set([...(prevEv.paths || []), ...(nextEv.paths || [])])];
  const viewportMetrics = unionObj(prevEv.viewport_metrics, nextEv.viewport_metrics);
  const stateConfirmations = unionObj(prevEv.state_confirmations, nextEv.state_confirmations);
  const horizontalOverflow = Object.entries(viewportMetrics)
    .filter(([, m]) => m && typeof m.scrollWidth === "number" && typeof m.clientWidth === "number"
      && m.scrollWidth > m.clientWidth + 1)
    .map(([prefix, m]) => `${prefix}: scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}`);
  const smallTouchTargets = Object.entries(viewportMetrics)
    .filter(([, m]) => m && typeof m.small_touch_target_count === "number" && m.small_touch_target_count > 0)
    .map(([prefix, m]) => `${prefix}: ${m.small_touch_target_count} control(s) under 44px min target`);
  const unconfirmedStates = [
    ...Object.entries(stateConfirmations)
      .filter(([, confirmation]) => !confirmation || confirmation.confirmed !== true)
      .map(([prefix, confirmation]) => `${prefix}: expected ${confirmation?.expected || "unknown"}, observed ${confirmation?.observed || "none"}`),
    ...unionList(prevEv.unconfirmed_states, nextEv.unconfirmed_states),
  ];
  const runtimeErrors = [
    ...unionList(prevEv.runtime_errors, nextEv.runtime_errors),
    ...unconfirmedStates.map((message) => `state_confirmation: ${message}`),
  ];
  return {
    ...prev,
    ...nextMeta,
    evidence: {
      ...prevEv,
      ...nextEv,
      paths,
      screenshots: paths.length,
      captures: unionObj(prevEv.captures, nextEv.captures),
      failures: unionObj(prevEv.failures, nextEv.failures),
      runtime_errors: runtimeErrors,
      unconfirmed_states: unconfirmedStates,
      viewport_metrics: viewportMetrics,
      state_confirmations: stateConfirmations,
      horizontal_overflow: horizontalOverflow,
      small_touch_targets: smallTouchTargets,
      dom_metrics_coverage: Object.values(viewportMetrics).some((m) => m && m.dom_metrics === "unmeasured_cli_runner")
        ? "partial: CLI runner cannot evaluate DOM; containment/touch findings above are Playwright-only"
        : "full",
      ...aggregateTriState(viewportMetrics, nextEv.measurement_tier || prevEv.measurement_tier || "cli"),
    },
  };
}

// Document-level tri-state aggregation over per-viewport metrics. Booleans
// collapse to `every(measured)`, strings to the single shared value or the list
// of observed values, and a field no viewport measured comes back `null` and is
// named in `unmeasured` — unmeasured is never reported as false or clean.
export function aggregateTriState(viewportMetrics, tier = "playwright") {
  const valuesFor = (key) => Object.values(viewportMetrics || {}).map((m) => m && m[key]);
  const domMeasured = Object.values(viewportMetrics || {}).some((m) => m && m.dom_metrics !== "unmeasured_cli_runner");
  const metricEntries = Object.entries(viewportMetrics || {});
  const missing = (key) => tier !== "playwright" || !domMeasured || metricEntries.length === 0
    || metricEntries.some(([, m]) => !m || m[key] === null || m[key] === undefined);
  const bools = (key) => valuesFor(key).filter((v) => typeof v === "boolean");
  const langs = [...new Set(valuesFor("lang").filter((v) => typeof v === "string"))];
  const fontsValues = bools("fonts_loaded");
  const wrapValues = bools("heading_text_wrap");
  const unmeasured = [];
  // DOM signals are unmeasured whenever no captured viewport actually evaluated
  // the page — the runner label is a hint, the per-viewport record is the fact.
  if (!domMeasured) unmeasured.push("dom_metrics");
  // A stale earlier capture in the union must not resurrect a value the current
  // runner cannot measure: the tier gate decides null, not the leftover record.
  const langValue = missing("lang") || langs.length === 0 ? null : langs.length === 1 ? langs[0] : langs;
  const fontsValue = missing("fonts_loaded") || fontsValues.length === 0 ? null : fontsValues.every(Boolean);
  const wrapValue = missing("heading_text_wrap") || wrapValues.length === 0 ? null : wrapValues.every(Boolean);
  if (langValue === null) unmeasured.push("lang");
  if (fontsValue === null) unmeasured.push("fonts_loaded");
  if (wrapValue === null) unmeasured.push("heading_text_wrap");
  return {
    measurement_tier: tier,
    lang: langValue,
    fonts_loaded: fontsValue,
    heading_text_wrap: wrapValue,
    unmeasured,
  };
}

// The script may live anywhere; evidence is written only into a repository that
// actually carries the spec-prototype Skill, never into whatever tree happens to
// contain this file.
export function resolveEvidenceRoot(explicit) {
  const primary = typeof explicit === "string" && explicit.length > 0 ? explicit : null;
  // An explicit root is authoritative: if it is not a spec-prototype repository we
  // refuse rather than silently writing into the current working tree.
  const candidates = primary ? [primary] : [process.env.LOOM_REPO_ROOT, process.cwd()];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const abs = path.resolve(candidate);
    // Accept both install layouts: the repo checkout (`<root>/skills/...`) and
    // a host Skill install (`<root>/.claude/skills/...`). Without the `.claude`
    // branch, envelope capture commands record evidence as no_repository_root.
    if (fs.existsSync(path.join(abs, "skills", "spec-prototype"))) return abs;
    if (fs.existsSync(path.join(abs, ".claude", "skills", "spec-prototype"))) return abs;
  }
  return null;
}

export function recordHandoffEvidence(outputDir, result, metadata, options = {}) {
  try {
    if (options.noManifest) return { written: false, reason: "manifest_disabled" };
    let manifestPath;
    if (options.manifestPath) {
      manifestPath = path.resolve(options.manifestPath);
    } else {
      const isProbeDir = outputDir && (outputDir.includes("/probes/") || outputDir.includes("\\probes\\"));
      // Ad-hoc captures keep their manifest beside their screenshots, so a capture
      // run from a sandbox never overwrites the repo's handoff manifest. Only slice
      // handoff needs a repo root.
      // ponytail: slice handoff still targets the repo manifest unless --manifest is given.
      if (isProbeDir && !options.isSliceHandoff) {
        manifestPath = path.join(outputDir, "capture-manifest.json");
      } else if (options.isSliceHandoff) {
        const repoRoot = resolveEvidenceRoot(options.repoRoot);
        if (!repoRoot) return { written: false, reason: "no_repository_root" };
        manifestPath = path.join(repoRoot, "prototype/evidence/handoff-manifest.json");
      } else {
        manifestPath = path.join(outputDir, "handoff-manifest.json");
      }
    }
    if (!fs.existsSync(path.dirname(manifestPath))) {
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    }
    let existing = {};
    if (fs.existsSync(manifestPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      } catch {}
    }
    existing.verification = mergeVerification(existing.verification, metadata);
    fs.writeFileSync(manifestPath, JSON.stringify(existing, null, 2), "utf-8");
    return { written: true, path: manifestPath };
  } catch (error) {
    // best-effort evidence recording
    return { written: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Diagnostics summary as a tri-state, so the CLI runner's blind spots read as
// `null` (unmeasured) instead of `false`/`0`/`true`. `every()` over an empty set
// returning `true` was the specific false-clean: a CLI capture measured no
// stylesheets and reported success.
export function buildDiagnosticsSummary(result) {
  const tier = result.runner === "system-browser-cli-concurrent" ? "cli" : "playwright";
  const entries = Object.entries(result.viewport_metrics || {});
  const domMeasured = tier === "playwright"
    && entries.some(([, m]) => m && m.dom_metrics !== "unmeasured_cli_runner");
  const measured = (m) => domMeasured && m && m.dom_metrics !== "unmeasured_cli_runner";
  const known = (key) => entries.filter(([, m]) => measured(m) && m[key] !== null && m[key] !== undefined);
  const unmeasuredViewports = entries
    .filter(([, m]) => !measured(m) || m.horizontal_overflow === undefined || m.stylesheets_applied === undefined)
    .map(([prefix]) => prefix);
  const unmeasured = [];
  const reduceBool = (key, combine) => {
    const measuredEntries = known(key);
    if (measuredEntries.length === 0 || measuredEntries.length !== entries.length) {
      unmeasured.push(key);
      return null;
    }
    return combine(measuredEntries.map(([, m]) => m[key]));
  };
  const part = (key) => entries.filter(([, m]) => measured(m) && typeof m[key] === "boolean").map(([, m]) => m[key]);
  const horizontalOverflow = reduceBool("horizontal_overflow", (values) => values.some(Boolean));
  const stylesheetsApplied = reduceBool("stylesheets_applied", (values) => values.every(Boolean));
  const touchKnown = entries.filter(([, m]) => measured(m) && typeof m.small_touch_target_count === "number");
  let touchCount = null;
  if (touchKnown.length === 0 || touchKnown.length !== entries.length) {
    unmeasured.push("small_touch_targets_count");
  } else {
    touchCount = touchKnown.reduce((acc, [, m]) => acc + m.small_touch_target_count, 0);
  }
  const craftCheck = (key) => (part(key).length === 0 || part(key).length !== entries.length ? null : part(key).some(Boolean));
  return {
    status: result.status,
    ...aggregateTriState(result.viewport_metrics, tier),
    runtime_errors: result.runtime_errors || [],
    horizontal_overflow: horizontalOverflow,
    stylesheets_applied: stylesheetsApplied,
    craft_checks: {
      has_active_feedback: craftCheck("has_active_feedback"),
      has_tabular_nums: craftCheck("has_tabular_nums"),
    },
    small_touch_targets_count: touchCount,
    unmeasured_viewports: unmeasuredViewports,
    unmeasured: [...new Set([...aggregateTriState(result.viewport_metrics, tier).unmeasured, ...unmeasured])],
  };
}

// Resolve the capture viewport ladder for a slice: declared widths win, 320
// always stays as the fold check. The declarations are read through the one
// design-record seam (`spec_contract_blocks.read_design_record`), never a
// second JS parser: a single-record `discussion.md` and a layered
// `truth.md`/`world.md`/`briefs/<slice>.md` tree resolve identically, and a
// declaration the compiler drops cannot survive here as a divergent parse.
// The seam's precedence mirrors the compiler: contract:viewports outranks the
// frontmatter carrier.
function sliceScope(root, sliceId) {
  const script = path.join(__dirname, "spec_contract_blocks.py");
  try {
    const out = execFileSync("python3", [script, "--dump", root, sliceId], { encoding: "utf-8" });
    return JSON.parse(out);
  } catch (err) {
    // "Nothing declared" (the helper exits 0 with nulls) is a legitimate fallback;
    // a non-zero exit means the seam found a malformed block or a broken fragment
    // and refused to parse it. The latter must not degrade to a default ladder —
    // capturing the wrong viewports would record evidence that never covered the
    // declared scope. Fail the capture with the helper's own diagnosis.
    const diag = (err && err.stderr) ? String(err.stderr).trim() : String(err && err.message || err);
    throw new Error(`capture: design-record scope could not be resolved (${diag})`);
  }
}

export function resolveSliceViewports(root, sliceId) {
  const scope = sliceScope(root, sliceId);
  return scope && Array.isArray(scope.viewports) ? scope.viewports : null;
}

// Mirror of resolveSliceViewports for contract:required_states: the slice's
// declared test states outrank the hardcoded fallback, exactly as declared
// viewports outrank the default ladder. "default" stays pinned first so the
// canonical `${vp}.png` first-impression capture keeps its source.
export function resolveSliceStates(root, sliceId) {
  const scope = sliceScope(root, sliceId);
  return scope && Array.isArray(scope.required_states) ? scope.required_states : null;
}

async function main() {
  const args = process.argv.slice(2);
  let url = null;
  let outputDir = null;
  let viewports = ["320", "390", "1280"];
  let states = ["default"];
  let schemes = ["light"];
  let viewportsExplicit = false;
  let statesExplicit = false;
  let schemesExplicit = false;
  let density = null;
  let forcedColors = "none";
  let contrast = "no-preference";
  let customManifest = null;
  let noManifest = false;
  let isSliceHandoff = false;
  let targetPath = null;
  let targetPlatform = "web";
  let runtime = "unknown";
  let sourceRevision = "unversioned";
  let repoRoot = null;
  const dependencies = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target-path") {
      targetPath = args[++i] || null;
    } else if (args[i] === "--target-platform") {
      targetPlatform = args[++i] || "web";
    } else if (args[i] === "--runtime") {
      runtime = args[++i] || "unknown";
    } else if (args[i] === "--source-revision") {
      sourceRevision = args[++i] || "unversioned";
    } else if (args[i] === "--dep") {
      const raw = args[++i] || "";
      const eq = raw.indexOf("=");
      if (eq > 0) dependencies.push({ ref: raw.slice(0, eq), digest: raw.slice(eq + 1) });
      else if (raw) dependencies.push({ ref: raw, digest: null });
    } else if (args[i] === "--repo-root") {
      repoRoot = args[++i] || null;
    } else if (args[i] === "--slice") {
      const sliceId = args[++i];
      // Repo-root resolution order (SSOT): explicit --repo-root wins, then
      // LOOM_REPO_ROOT, then a marker walk from cwd upward so a Skill
      // installed under `<root>/.claude/skills/` still resolves correctly.
      // The old `__dirname/../../..` fallback mis-derived the root whenever
      // the scripts live inside a `.claude` install rather than `<root>/skills/`.
      const scriptRoot = path.resolve(__dirname, "../..");
      const markerIsRoot = (abs) =>
        fs.existsSync(path.join(abs, "prototype")) &&
        (fs.existsSync(path.join(abs, "skills", "spec-prototype")) ||
          fs.existsSync(path.join(abs, ".claude", "skills", "spec-prototype")));
      let resolvedRoot = repoRoot || process.env.LOOM_REPO_ROOT || null;
      if (!resolvedRoot) {
        for (let dir = path.resolve(process.cwd()); ; dir = path.dirname(dir)) {
          if (markerIsRoot(dir)) { resolvedRoot = dir; break; }
          if (dir === path.dirname(dir)) break; // filesystem root
        }
      }
      if (!resolvedRoot && markerIsRoot(scriptRoot)) resolvedRoot = scriptRoot;
      const root = resolvedRoot ? path.resolve(resolvedRoot) : path.resolve(__dirname, "../../..");
      const candidatePaths = [
        path.join(root, `prototype/experiments/${sliceId}/anchor/index.html`),
        path.join(root, `prototype/experiments/${sliceId}/hero-anchor/index.html`),
        path.join(root, `prototype/experiments/${sliceId}/r1/index.html`),
        path.join(root, `prototype/experiments/${sliceId}/index.html`),
        path.join(root, `prototype/surfaces/${sliceId}/index.html`),
      ];
      const matched = candidatePaths.find((p) => fs.existsSync(p));
      if (!matched) {
        process.stderr.write(`target_html_not_found: no prototype HTML found for slice '${sliceId}' under ${path.join(root, "prototype")}\n`);
        process.exit(2);
      }
      url = `file://${matched}`;
      outputDir = path.join(root, `prototype/evidence/probes/${sliceId}/`);
      // Slice defaults are a fallback: an explicit --viewports/--states wins
      // regardless of argument order, so the envelope's derived gates survive.
      // Declared required_states (brief frontmatter or contract block) outrank
      // the hardcoded triple, with "default" pinned first for the canonical
      // `${vp}.png` first-impression capture.
      if (!statesExplicit) {
        const declaredStates = resolveSliceStates(root, sliceId);
        states = declaredStates
          ? (declaredStates.includes("default")
              ? declaredStates
              : ["default", ...declaredStates])
          : ["default", "stressed", "empty"];
      }
      // Viewport ladder follows the slice's declared viewports when authored
      // (brief frontmatter or contract:viewports block), keeping 320 as the
      // fold check; otherwise the default ladder applies.
      if (!viewportsExplicit) {
        const declared = resolveSliceViewports(root, sliceId);
        viewports = declared
          ? [...new Set([...declared, 320])].sort((a, b) => a - b).map(String)
          : ["320", "390", "1280"];
      }
      isSliceHandoff = true;
    } else if (args[i] === "--output" || args[i] === "--out" || args[i] === "-o") {
      outputDir = args[++i];
    } else if (args[i] === "--target" || args[i] === "-t") {
      url = args[++i];
    } else if (args[i] === "--viewports" || args[i] === "-v") {
      viewports = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      viewportsExplicit = true;
    } else if (args[i] === "--states" || args[i] === "-s") {
      states = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      statesExplicit = true;
    } else if (args[i] === "--schemes") {
      schemes = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = schemes.filter((s) => !["light", "dark"].includes(s));
      if (unknown.length) {
        process.stderr.write(`--schemes accepts light and/or dark (got: ${unknown.join(",")})\n`);
        process.exit(2);
      }
      schemesExplicit = true;
    } else if (args[i] === "--density") {
      density = args[++i] || null;
    } else if (args[i] === "--forced-colors") {
      forcedColors = args[++i] || "active";
      if (!["none", "active"].includes(forcedColors)) {
        process.stderr.write("--forced-colors accepts none or active\n");
        process.exit(2);
      }
    } else if (args[i] === "--contrast") {
      contrast = args[++i] || "more";
      if (!["no-preference", "more", "less", "custom"].includes(contrast)) {
        process.stderr.write("--contrast accepts no-preference, more, less, or custom\n");
        process.exit(2);
      }
    } else if (args[i] === "--manifest" || args[i] === "-m") {
      customManifest = args[++i] || null;
    } else if (args[i] === "--no-manifest") {
      noManifest = true;
    } else if (!url && !args[i].startsWith("-")) {
      url = args[i];
    } else if (!args[i].startsWith("-")) {
      // A stray value (e.g. `--viewports 1440 390`) would otherwise be dropped
      // silently and the batch would under-cover the declared viewports.
      process.stderr.write(`Unexpected argument: ${args[i]} (use comma-separated lists, e.g. --viewports 1440,390)\n`);
      process.exit(2);
    }
  }

  if (!url || !outputDir) {
    process.stderr.write("Usage: node capture.mjs <url> --output <dir> [--viewports 320,390,1280] [--states ideal,error]\n");
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Try Playwright
  let result = await captureWithPlaywright(url, outputDir, viewports, states, schemes, density,
                                           forcedColors, contrast);

  // 2. Try System Browser CLI if Playwright unavailable
  if (!result) {
    const browserBin = findSystemBrowser();
    if (browserBin) {
      result = await captureWithCli(browserBin, url, outputDir, viewports, states, schemes, density);
    }
  }

  const metadataOptions = {
    targetPath,
    targetUri: url,
    targetPlatform,
    runtime,
    sourceRevision,
    dependencies,
    repoRoot,
    // The requested preferences ride along so a reader can tell "captured with
    // forced colors requested" from "the page was never asked".
    requested: { schemes, density, forcedColors, contrast },
  };

  if (result) {
    const metadata = buildCaptureMetadata(result, metadataOptions);
    const recording = recordHandoffEvidence(outputDir, result, metadata, {
      repoRoot,
      noManifest,
      isSliceHandoff,
      manifestPath: customManifest,
    });
    const diagnostics_summary = buildDiagnosticsSummary(result);
    process.stdout.write(JSON.stringify({ ...result, diagnostics_summary, metadata, evidence_record: recording }, null, 2) + "\n");
    process.exit(0);
  } else {
    // A failed capture is a result, not silence: emit explicit metadata and never
    // record it as usable evidence.
    const failure = {
      status: "browser_unavailable",
      reason: "No browser runner found (Playwright package or system Chrome/Chromium/Edge)",
      metadata: buildCaptureMetadata({ status: "browser_unavailable" }, metadataOptions),
    };
    process.stdout.write(JSON.stringify(failure, null, 2) + "\n");
    process.exit(2);
  }
}

// Importable seam: the module is inert unless executed directly (`node capture.mjs`).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
