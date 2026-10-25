#!/usr/bin/env node
// Headless multi-viewport and multi-state screenshot capture for paseo-ui evidence.
// Uses local/global Playwright or system Chrome/Edge. Zero extra dependencies.
//
// Usage: node capture.mjs <url> --out <dir> [--viewports 320,390,768,1280]
//          [--states default,stressed,empty,error] [--mock <mocks.json>]
//
// States are entered either by the page itself (data-state attribute) or by
// network mocks (--mock): each state's routes are fulfilled by Playwright, and a
// state counts as entered only when every one of its routes was actually hit.
// Mock file shape: { "*": [route...], "<state>": [route...] } where a route is
//   { "url": "**/api/tasks*", "status": 200, "json": {...} | "body": "..." |
//     "bodyFile": "relative/to/mock/file.json", "contentType": "...",
//     "delayMs": 0, "abort": false }

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import net from "node:net";

const pExecFile = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function findFreePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.status >= 200 && res.status < 500) return true;
    } catch {
      try {
        const res = await fetch(url, { method: "GET" });
        if (res.status >= 200 && res.status < 500) return true;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

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
export function confirmStateEntry(expectedState, dom, options = {}) {
  const raw = dom.bodyState || dom.htmlState || dom.appliedRootState || "";
  const urlEcho = dom.urlEcho || "";
  const domEcho = expectedState !== "default" && (dom.domText || "").includes(expectedState);
  const declared = raw || urlEcho;
  const actionFailed = Boolean(options && options.actionError);
  const baseConfirmed = expectedState === "default"
    ? declared === "default" || declared === ""
    : raw === expectedState || (urlEcho === expectedState && domEcho);
  return {
    expected: expectedState,
    observed: actionFailed
      ? `${declared || "none"}; action_failed: ${options.actionError}`
      : declared,
    action_error: (options && options.actionError) || null,
    confirmed: baseConfirmed && !actionFailed,
  };
}

// Mock-driven state entry. A state backed by network mocks is confirmed only
// when every state-specific route was intercepted at least once: a route that
// never fired means the page did not request that data, so the screenshot does
// not show the injected state. Pure so the rule is testable without a browser.
export function confirmMockedState(expectedState, routes, hits, options = {}) {
  const total = routes.length;
  const hitCount = hits.filter((n) => n > 0).length;
  const missed = routes.filter((_, i) => !(hits[i] > 0)).map((r) => r.url);
  const actionFailed = Boolean(options && options.actionError);
  const observed = actionFailed
    ? `mock:${hitCount}/${total} routes hit; action_failed: ${options.actionError}`
    : `mock:${hitCount}/${total} routes hit`;
  return {
    expected: expectedState,
    observed,
    signal: "mock",
    missed_routes: missed,
    action_error: (options && options.actionError) || null,
    confirmed: total > 0 && hitCount === total && !actionFailed,
  };
}

// Load and validate a mock file. Body sources are resolved relative to the
// mock file so a fixture directory can be moved as a unit. Supports scenario
// actions for deep interaction capture (e.g. click modal/drawer triggers).
export function loadMocks(mockPath) {
  const abs = path.resolve(mockPath);
  const raw = JSON.parse(fs.readFileSync(abs, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("mock file must be an object keyed by state name (or \"*\")");
  }
  const mocks = {};
  const actions = {};
  for (const [state, value] of Object.entries(raw)) {
    if (state.endsWith(":actions")) {
      const targetState = state.replace(/:actions$/, "");
      actions[targetState] = Array.isArray(value) ? value : [value];
      continue;
    }
    const routes = Array.isArray(value)
      ? value
      : (value && Array.isArray(value.routes) ? value.routes : null);
    if (!routes) throw new Error(`mock state '${state}' must map to an array of routes or { routes: [...] }`);
    if (value && Array.isArray(value.actions)) {
      actions[state] = value.actions;
    }
    mocks[state] = routes.map((route, i) => {
      if (!route || typeof route.url !== "string" || route.url.length === 0) {
        throw new Error(`mock state '${state}' route #${i} is missing "url"`);
      }
      let body = null;
      let contentType = route.contentType || null;
      if (route.json !== undefined) {
        body = JSON.stringify(route.json);
        contentType = contentType || "application/json";
      } else if (typeof route.bodyFile === "string") {
        body = fs.readFileSync(path.resolve(path.dirname(abs), route.bodyFile), "utf-8");
        contentType = contentType || (route.bodyFile.endsWith(".json") ? "application/json" : "text/plain");
      } else if (typeof route.body === "string") {
        body = route.body;
      }
      return {
        url: route.url,
        status: Number.isInteger(route.status) ? route.status : 200,
        body: body ?? "",
        contentType: contentType || "text/plain",
        delayMs: Number.isFinite(route.delayMs) ? route.delayMs : 0,
        abort: route.abort === true,
      };
    });
  }
  mocks.__actions = actions;
  return mocks;
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
                                     forcedColors = "none", contrast = "no-preference", concurrency = 4,
                                     mocks = null) {
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
        // A mock-driven state is entered through the network, not the URL: the
        // ?state= echo would only confuse a router that does not expect it.
        const mocked = Boolean(mocks && mocks[state] && mocks[state].length > 0);
        const stateUrl = buildVariantUrl(baseUrl, mocked ? "default" : state, scheme, density);
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
        await page.addInitScript(() => {
          window.__layoutShiftScore = 0;
          try {
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (!entry.hadRecentInput) {
                  window.__layoutShiftScore += entry.value;
                }
              }
            }).observe({ type: "layout-shift", buffered: true });
          } catch {}
        });
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
        // Shared routes ("*") apply to every state; state routes are registered
        // last so they take precedence (Playwright runs the newest route first).
        const sharedRoutes = (mocks && mocks["*"]) || [];
        const stateRoutes = (mocks && mocks[state]) || [];
        const stateHits = stateRoutes.map(() => 0);
        const installRoute = async (route, onHit) => {
          await page.route(route.url, async (r) => {
            onHit();
            if (route.delayMs > 0) await new Promise((res) => setTimeout(res, route.delayMs));
            if (route.abort) return r.abort("failed");
            return r.fulfill({ status: route.status, contentType: route.contentType, body: route.body });
          });
        };
        for (const route of sharedRoutes) await installRoute(route, () => {});
        for (const [i, route] of stateRoutes.entries()) await installRoute(route, () => { stateHits[i] += 1; });
        await page.goto(stateUrl, { waitUntil: "networkidle", timeout: 15000 });

        // Deep modal/drawer scenario actions: execute if defined for this state
        const stateActions = (mocks && mocks.__actions && mocks.__actions[state]) || [];
        let actionError = null;
        for (const act of stateActions) {
          try {
            if (act.click) {
              await page.waitForSelector(act.click, { timeout: act.timeoutMs || 5000 });
              await page.click(act.click);
            }
            if (act.fill && act.selector) {
              await page.waitForSelector(act.selector, { timeout: act.timeoutMs || 5000 });
              await page.fill(act.selector, act.fill);
            }
            if (act.waitMs) {
              await page.waitForTimeout(act.waitMs);
            }
          } catch (actionErr) {
            actionError = actionErr.message;
            runtimeErrors.push(`[${prefix}:action] ${actionErr.message}`);
            break;
          }
        }

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
        const stateConfirmation = stateRoutes.length > 0
          ? confirmMockedState(state, stateRoutes, stateHits, { actionError })
          : confirmStateEntry(state, domFacts, { actionError });
        stateConfirmations[prefix] = stateConfirmation;
        if (!stateConfirmation.confirmed) {
          throw new Error(`state_unconfirmed: expected ${state}, observed ${stateConfirmation.observed || "none"}`);
        }
        // Viewport containment evidence: record horizontal overflow at capture
        // time so a scrollWidth > clientWidth break surfaces in the same pass
        // as the screenshot instead of only at downstream task judging.
        const metrics = await page.evaluate(({ failed, viewportWidth }) => {
          const de = document.documentElement;
          const smallTargets = [];
          const isDesktop = typeof viewportWidth === "number" ? viewportWidth > 768 : window.innerWidth > 768;
          // Responsive touch target threshold:
          // Desktop (mouse pointer): WCAG 2.2 2.5.8 (Level AA) minimum target size is 24x24px.
          // Mobile (touch input): WCAG 2.5.5 (Level AAA) / mobile UI standard is 44x44px.
          const minTargetSize = isDesktop ? 24 : 44;
          const isInteractive = (el) => Boolean(el.closest("button:not([disabled]), a[href], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role=button]:not([aria-disabled=true]), [role=tab], [role=checkbox], [role=switch], [role=radio], summary"));
          for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=tab], summary")) {
            if (!isInteractive(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const inlineException = el.hasAttribute("data-inline-target-exception");
            if ((r.width < minTargetSize || r.height < minTargetSize) && !inlineException) {
              smallTargets.push({
                tag: el.tagName.toLowerCase(),
                label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
                width: Math.round(r.width),
                height: Math.round(r.height),
                min_expected: minTargetSize,
                viewport_tier: isDesktop ? "desktop-24px" : "mobile-44px",
              });
            }
          }

          const failedSet = new Set(failed || []);
          const activeSelectors = [];
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
                  // Walk grouping rules (@media, @layer, @supports) too: utility
                  // frameworks often emit :active variants inside them.
                  const walk = (rules) => {
                    for (const rule of rules) {
                      if (rule.selectorText && rule.selectorText.includes(":active")) {
                        for (const part of rule.selectorText.split(",")) {
                          if (part.includes(":active")) activeSelectors.push(part.replace(/:active/g, "").trim() || "*");
                        }
                      } else if (rule.cssRules) {
                        walk(rule.cssRules);
                      }
                    }
                  };
                  walk(sheet.cssRules);
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

          // Press feedback is measured per control, not per stylesheet: a lone
          // `a:active` reset rule must not certify every button on the page.
          const pressables = [...document.querySelectorAll("button, [role=button], a[href]")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
          const matchesActive = (el) => activeSelectors.some((sel) => {
            try { return el.matches(sel); } catch { return false; }
          });
          const pressCovered = pressables.filter(matchesActive).length;
          const activeFeedback = { covered: pressCovered, total: pressables.length };

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

          // Button text wrap probe: detect accidental multi-line text wrapping inside buttons
          const buttonWraps = [];
          for (const btn of document.querySelectorAll("button, [role=button]")) {
            const r = btn.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const textNodes = [];
            const walk = (node) => {
              if (node.nodeType === 3 && node.textContent.trim()) textNodes.push(node);
              else if (node.nodeType === 1 && !["SVG", "svg", "IMG", "img"].includes(node.tagName)) {
                for (const c of node.childNodes) walk(c);
              }
            };
            walk(btn);
            for (const tn of textNodes) {
              const range = document.createRange();
              range.selectNodeContents(tn);
              const rects = range.getClientRects();
              if (rects.length > 1) {
                buttonWraps.push({
                  tag: btn.tagName.toLowerCase(),
                  label: (btn.getAttribute("aria-label") || btn.textContent || "").trim().slice(0, 30),
                  lines: rects.length,
                });
                break;
              }
            }
          }

          // Realtime DOM contrast probe: WCAG AA check (4.5:1 normal, 3.0:1 large/bold)
          function parseRgb(str) {
            if (!str) return null;
            const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m) return null;
            return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
          }
          function calcLuminance(rgb) {
            const a = rgb.map((v) => {
              v /= 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
          }
          function calcContrast(rgb1, rgb2) {
            const l1 = calcLuminance(rgb1);
            const l2 = calcLuminance(rgb2);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          }
          const lowContrastElements = [];
          for (const el of document.querySelectorAll("p, span, h1, h2, h3, h4, h5, h6, button, a, label, td, th")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const text = (el.textContent || "").trim();
            if (!text || el.children.length > 3) continue;
            const comp = window.getComputedStyle(el);
            const fg = parseRgb(comp.color);
            if (!fg) continue;
            let bg = null;
            let cur = el;
            while (cur) {
              const bgComp = window.getComputedStyle(cur);
              if (bgComp.backgroundColor && bgComp.backgroundColor !== "transparent" && !bgComp.backgroundColor.includes("rgba(0, 0, 0, 0)")) {
                bg = parseRgb(bgComp.backgroundColor);
                break;
              }
              cur = cur.parentElement;
            }
            if (!bg) bg = [255, 255, 255];
            const ratio = calcContrast(fg, bg);
            const fontSize = parseFloat(comp.fontSize) || 14;
            const isBold = parseInt(comp.fontWeight, 10) >= 700 || comp.fontWeight === "bold";
            const threshold = (fontSize >= 18 || (fontSize >= 14 && isBold)) ? 3.0 : 4.5;
            if (ratio < threshold) {
              lowContrastElements.push({
                tag: el.tagName.toLowerCase(),
                text: text.slice(0, 30),
                ratio: Number(ratio.toFixed(2)),
                expected: threshold,
              });
            }
          }

          // Form controls label probe (WCAG 2.1 / Vercel guidelines)
          const unlabeledControls = [];
          for (const fc of document.querySelectorAll("input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), select, textarea")) {
            const r = fc.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const hasAriaLabel = Boolean(fc.getAttribute("aria-label")?.trim());
            const hasAriaLabelledBy = Boolean(fc.getAttribute("aria-labelledby")?.trim());
            const id = fc.id;
            const hasExplicitLabel = id ? Boolean(document.querySelector(`label[for="${id}"]`)) : false;
            const hasWrappingLabel = Boolean(fc.closest("label"));
            if (!hasAriaLabel && !hasAriaLabelledBy && !hasExplicitLabel && !hasWrappingLabel) {
              unlabeledControls.push({
                tag: fc.tagName.toLowerCase(),
                name: fc.getAttribute("name") || fc.id || null,
                type: fc.getAttribute("type") || null,
              });
            }
          }

          // Autocomplete probe for textual inputs
          const missingAutocompletes = [];
          for (const ti of document.querySelectorAll('input[type="text"], input[type="email"], input[type="password"], input[type="tel"], input[type="url"]')) {
            const r = ti.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const auto = ti.getAttribute("autocomplete");
            if (!auto || !auto.trim()) {
              missingAutocompletes.push({
                name: ti.getAttribute("name") || ti.id || null,
                type: ti.getAttribute("type") || "text",
              });
            }
          }

          // Table header scope probe
          const thWithoutScopes = [];
          for (const th of document.querySelectorAll("table th")) {
            const r = th.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const scope = (th.getAttribute("scope") || "").toLowerCase().trim();
            if (!["col", "row", "colgroup", "rowgroup"].includes(scope)) {
              thWithoutScopes.push({
                text: (th.textContent || "").trim().slice(0, 30),
              });
            }
          }

          // Numeric cell alignment and tabular-nums probe
          const numericMisaligned = [];
          const numericPattern = /^[¥$€£]?\s*-?\d[\d,]*(\.\d+)?%?$/;
          for (const td of document.querySelectorAll("table td")) {
            const r = td.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const text = (td.textContent || "").trim();
            if (numericPattern.test(text)) {
              const comp = window.getComputedStyle(td);
              const isRight = comp.textAlign === "right" || comp.textAlign === "end";
              const isTabular = (comp.fontVariantNumeric && comp.fontVariantNumeric.includes("tabular-nums")) ||
                (comp.fontFeatureSettings && (comp.fontFeatureSettings.includes("tnum") || comp.fontFeatureSettings.includes('"tnum" 1')));
              if (!isRight || !isTabular) {
                numericMisaligned.push({
                  text: text.slice(0, 20),
                  textAlign: comp.textAlign,
                  hasTabular: Boolean(isTabular),
                });
              }
            }
          }

          return {
            scrollWidth: de.scrollWidth,
            clientWidth: de.clientWidth,
            scrollHeight: de.scrollHeight,
            clientHeight: de.clientHeight,
            horizontal_overflow: hasOverflow,
            stylesheets_applied: stylesheetsApplied,
            has_active_feedback: pressables.length === 0 ? null : pressCovered > 0,
            active_feedback_coverage: activeFeedback,
            has_tabular_nums: hasTabularNums,
            button_text_wrap: buttonWraps.length > 0,
            button_text_wraps: buttonWraps.slice(0, 5),
            button_text_wrap_count: buttonWraps.length,
            low_contrast_count: lowContrastElements.length,
            low_contrast_elements: lowContrastElements.slice(0, 5),
            cls_score: Number((window.__layoutShiftScore || 0).toFixed(4)),
            unlabeled_control_count: unlabeledControls.length,
            unlabeled_controls: unlabeledControls.slice(0, 5),
            missing_autocomplete_count: missingAutocompletes.length,
            missing_autocompletes: missingAutocompletes.slice(0, 5),
            th_without_scope_count: thWithoutScopes.length,
            th_without_scopes: thWithoutScopes.slice(0, 5),
            numeric_cell_misaligned_count: numericMisaligned.length,
            numeric_cell_misaligned: numericMisaligned.slice(0, 5),
            small_touch_targets: smallTargets.slice(0, 10),
            small_touch_target_count: smallTargets.length,
            min_touch_target_size: minTargetSize,
            viewport_tier: isDesktop ? "desktop" : "mobile",
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
        }, { failed: failedUrls, viewportWidth: dim.width });
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
    schema: "paseo-ui.capture-metadata.v1",
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
      craft_health_index: options.diagnostics_summary?.craft_health_index || null,
      craft_gate: options.diagnostics_summary?.craft_gate || null,
      dom_metrics_coverage: Object.values(viewportMetrics).some((m) => m && m.dom_metrics === "unmeasured_cli_runner")
        ? "partial: CLI runner cannot evaluate DOM; containment/touch findings above are Playwright-only"
        : "full",
      ...triState,
    },
    validation: {
      kind: "renderer_capture",
      claim: captured ? "renderer_screenshots_pending_review" : "capture_failed",
      craft_gate: options.diagnostics_summary?.craft_gate || null,
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

export function recordHandoffEvidence(outputDir, result, metadata, options = {}) {
  try {
    if (options.noManifest) return { written: false, reason: "manifest_disabled" };
    let manifestPath;
    if (options.manifestPath) {
      manifestPath = path.resolve(options.manifestPath);
    } else {
      // Captures keep their manifest beside their screenshots, so a run from a
      // worktree never writes evidence into another tree.
      manifestPath = path.join(outputDir, "capture-manifest.json");
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

  const wrapKnown = entries.filter(([, m]) => measured(m) && typeof m.button_text_wrap_count === "number");
  let buttonWrapCount = null;
  if (wrapKnown.length === 0 || wrapKnown.length !== entries.length) {
    unmeasured.push("button_text_wrap_count");
  } else {
    buttonWrapCount = wrapKnown.reduce((acc, [, m]) => acc + m.button_text_wrap_count, 0);
  }

  const contrastKnown = entries.filter(([, m]) => measured(m) && typeof m.low_contrast_count === "number");
  let lowContrastCount = null;
  if (contrastKnown.length === 0 || contrastKnown.length !== entries.length) {
    unmeasured.push("low_contrast_count");
  } else {
    lowContrastCount = contrastKnown.reduce((acc, [, m]) => acc + m.low_contrast_count, 0);
  }

  const clsKnown = entries.filter(([, m]) => measured(m) && typeof m.cls_score === "number");
  let maxClsScore = null;
  if (clsKnown.length === 0 || clsKnown.length !== entries.length) {
    unmeasured.push("cls_score");
  } else {
    maxClsScore = Math.max(...clsKnown.map(([, m]) => m.cls_score));
  }

  const unlabeledKnown = entries.filter(([, m]) => measured(m) && typeof m.unlabeled_control_count === "number");
  let unlabeledControlCount = null;
  if (unlabeledKnown.length === 0 || unlabeledKnown.length !== entries.length) {
    unmeasured.push("unlabeled_control_count");
  } else {
    unlabeledControlCount = unlabeledKnown.reduce((acc, [, m]) => acc + m.unlabeled_control_count, 0);
  }

  const autocompleteKnown = entries.filter(([, m]) => measured(m) && typeof m.missing_autocomplete_count === "number");
  let missingAutocompleteCount = null;
  if (autocompleteKnown.length === 0 || autocompleteKnown.length !== entries.length) {
    unmeasured.push("missing_autocomplete_count");
  } else {
    missingAutocompleteCount = autocompleteKnown.reduce((acc, [, m]) => acc + m.missing_autocomplete_count, 0);
  }

  const thScopeKnown = entries.filter(([, m]) => measured(m) && typeof m.th_without_scope_count === "number");
  let thWithoutScopeCount = null;
  if (thScopeKnown.length === 0 || thScopeKnown.length !== entries.length) {
    unmeasured.push("th_without_scope_count");
  } else {
    thWithoutScopeCount = thScopeKnown.reduce((acc, [, m]) => acc + m.th_without_scope_count, 0);
  }

  const numericMisalignedKnown = entries.filter(([, m]) => measured(m) && typeof m.numeric_cell_misaligned_count === "number");
  let numericCellMisalignedCount = null;
  if (numericMisalignedKnown.length === 0 || numericMisalignedKnown.length !== entries.length) {
    unmeasured.push("numeric_cell_misaligned_count");
  } else {
    numericCellMisalignedCount = numericMisalignedKnown.reduce((acc, [, m]) => acc + m.numeric_cell_misaligned_count, 0);
  }

  const craftCheck = (key) => (part(key).length === 0 || part(key).length !== entries.length ? null : part(key).some(Boolean));

  // Deduplicate small touch targets across viewports so repeating navigation/buttons
  // across states do not multiply deductions unfairly.
  const uniqueSmallTargets = new Map();
  for (const [, m] of entries) {
    if (m && Array.isArray(m.small_touch_targets)) {
      for (const t of m.small_touch_targets) {
        const key = `${t.tag}|${t.label}|${t.width}x${t.height}`;
        if (!uniqueSmallTargets.has(key)) {
          uniqueSmallTargets.set(key, t);
        }
      }
    }
  }
  const uniqueSmallTouchCount = uniqueSmallTargets.size;

  // Runtime fatal crashes fail-closed: unhandled page script crashes (e.g. TypeErrors
  // causing white screens) or broken interaction actions cannot be waived by a blank DOM.
  const runtimeErrors = Array.isArray(result.runtime_errors) ? result.runtime_errors : [];
  const pageErrors = runtimeErrors.filter((e) => !e.includes(":action]"));
  const actionErrors = runtimeErrors.filter((e) => e.includes(":action]"));
  let fatalCrash = false;
  let fatalReason = "";
  if (pageErrors.length > 0) {
    fatalCrash = true;
    fatalReason = `runtime_errors detected: ${pageErrors.slice(0, 2).join("; ")}`;
  } else if (actionErrors.length > 0) {
    fatalCrash = true;
    fatalReason = `action_errors detected: ${actionErrors.slice(0, 2).join("; ")}`;
  }

  // Deterministic Craft Health Index (CHI: 0-100)
  const deductions = [];
  let score = 100;

  if (fatalCrash) {
    deductions.push({ rule: "runtime_crash", points: 100, reason: fatalReason });
    score = 0;
  }

  if (horizontalOverflow === true) {
    deductions.push({ rule: "containment", points: 30, reason: "Horizontal overflow detected on viewport(s)" });
    score -= 30;
  }
  if (typeof maxClsScore === "number" && maxClsScore >= 0.05) {
    const clsDeduct = maxClsScore < 0.1 ? 5 : Math.min(20, Math.max(10, Math.round(maxClsScore * 100)));
    deductions.push({ rule: "cls_layout_shift", points: clsDeduct, reason: `Cumulative Layout Shift ${maxClsScore.toFixed(3)} detected` });
    score -= clsDeduct;
  }
  if (typeof touchCount === "number" && uniqueSmallTouchCount > 0) {
    const touchDeduct = Math.min(15, uniqueSmallTouchCount * 3);
    deductions.push({ rule: "touch_target_size", points: touchDeduct, reason: `${uniqueSmallTouchCount} unique control(s) under target floor (${touchCount} occurrences across viewports)` });
    score -= touchDeduct;
  }
  if (typeof unlabeledControlCount === "number" && unlabeledControlCount > 0) {
    const labelDeduct = Math.min(15, unlabeledControlCount * 5);
    deductions.push({ rule: "form_a11y_labels", points: labelDeduct, reason: `${unlabeledControlCount} interactive control(s) missing label / aria-label` });
    score -= labelDeduct;
  }
  if (typeof thWithoutScopeCount === "number" && thWithoutScopeCount > 0) {
    const thDeduct = Math.min(6, thWithoutScopeCount * 2);
    deductions.push({ rule: "table_semantics", points: thDeduct, reason: `${thWithoutScopeCount} <th> header(s) missing scope="col|row"` });
    score -= thDeduct;
  }
  if (typeof numericCellMisalignedCount === "number" && numericCellMisalignedCount > 0) {
    const numDeduct = Math.min(6, numericCellMisalignedCount * 3);
    deductions.push({ rule: "numeric_alignment", points: numDeduct, reason: `${numericCellMisalignedCount} numeric table cell(s) not right-aligned with tabular-nums` });
    score -= numDeduct;
  }
  if (typeof lowContrastCount === "number" && lowContrastCount > 0) {
    const contrastDeduct = Math.min(10, lowContrastCount * 2);
    deductions.push({ rule: "text_contrast", points: contrastDeduct, reason: `${lowContrastCount} element(s) with contrast ratio below WCAG AA` });
    score -= contrastDeduct;
  }

  let activeCovered = 0;
  let activeTotal = 0;
  for (const [, m] of entries) {
    if (m && m.active_feedback_coverage && typeof m.active_feedback_coverage.total === "number") {
      activeCovered += m.active_feedback_coverage.covered || 0;
      activeTotal += m.active_feedback_coverage.total || 0;
    }
  }
  if (activeTotal > 0) {
    const activeRate = activeCovered / activeTotal;
    if (activeRate < 0.3) {
      deductions.push({ rule: "tactile_feedback", points: 10, reason: `Active feedback coverage critically low (${Math.round(activeRate * 100)}% < 30%)` });
      score -= 10;
    } else if (activeRate < 0.6) {
      deductions.push({ rule: "tactile_feedback", points: 5, reason: `Active feedback coverage suboptimal (${Math.round(activeRate * 100)}% < 60%)` });
      score -= 5;
    }
  }

  score = Math.max(0, Math.min(100, score));
  let grade = "A+";
  if (score < 60) grade = "F";
  else if (score < 70) grade = "D";
  else if (score < 80) grade = "C";
  else if (score < 90) grade = "B";
  else if (score < 95) grade = "A";
  else grade = "A+";

  const craft_health_index = {
    score,
    grade,
    deductions,
    total_deductions: 100 - score,
  };

  const gatePassed = !fatalCrash && craft_health_index.score >= 90;
  const gateReason = fatalCrash
    ? fatalReason
    : (gatePassed ? `Score ${score} >= 90 (Grade ${grade})` : `Score ${score} < 90 (Grade ${grade})`);

  return {
    status: result.status,
    ...aggregateTriState(result.viewport_metrics, tier),
    runtime_errors: result.runtime_errors || [],
    horizontal_overflow: horizontalOverflow,
    stylesheets_applied: stylesheetsApplied,
    craft_checks: {
      has_active_feedback: craftCheck("has_active_feedback"),
      has_tabular_nums: craftCheck("has_tabular_nums"),
      button_text_wrap_free: buttonWrapCount === null ? null : buttonWrapCount === 0,
      contrast_compliant: lowContrastCount === null ? null : lowContrastCount === 0,
      cls_compliant: maxClsScore === null ? null : maxClsScore < 0.1,
      form_controls_labeled: unlabeledControlCount === null ? null : unlabeledControlCount === 0,
      autocomplete_compliant: missingAutocompleteCount === null ? null : missingAutocompleteCount === 0,
      table_headers_scoped: thWithoutScopeCount === null ? null : thWithoutScopeCount === 0,
      numeric_cells_aligned: numericCellMisalignedCount === null ? null : numericCellMisalignedCount === 0,
    },
    craft_health_index,
    craft_gate: {
      // Stage 6 entry gate: CHI >= 90 (Grade A) and zero fatal crashes. Probe-unavailable dims are
      // excluded (null), never counted as pass.
      threshold: 90,
      passed: gatePassed,
      score,
      reason: gateReason,
    },
    max_cls_score: maxClsScore,
    small_touch_targets_count: touchCount,
    button_text_wrap_count: buttonWrapCount,
    low_contrast_count: lowContrastCount,
    unlabeled_control_count: unlabeledControlCount,
    missing_autocomplete_count: missingAutocompleteCount,
    th_without_scope_count: thWithoutScopeCount,
    numeric_cell_misaligned_count: numericCellMisalignedCount,
    unmeasured_viewports: unmeasuredViewports,
    unmeasured: [...new Set([...aggregateTriState(result.viewport_metrics, tier).unmeasured, ...unmeasured])],
  };
}

export async function runSelfTest() {
  process.stdout.write("Running paseo-ui capture.mjs self-test...\n");
  const isMain = isMainModule();
  const pw = await loadPlaywright();
  const sysBrowser = findSystemBrowser();
  let portOk = false;
  try {
    const port = await findFreePort();
    portOk = typeof port === "number" && port > 1024;
  } catch {}
  let accesslintOk = false;
  let accesslintChromeOk = false;
  try {
    const res = spawnSync("accesslint", ["--version"], { encoding: "utf8", timeout: 3000 });
    accesslintOk = res.status === 0;
  } catch {}
  try {
    const res = spawnSync("accesslint-chrome", ["--help"], { encoding: "utf8", timeout: 3000 });
    accesslintChromeOk = res.status === 0;
  } catch {}
  const searchPyPath = path.resolve(__dirname, "vendor/ui-ux-pro-max/scripts/search.py");
  const searchPyExists = fs.existsSync(searchPyPath);

  const dummyDom = { bodyState: "stressed", domText: "stressed error" };
  const confState = confirmStateEntry("stressed", dummyDom);
  const confMock = confirmMockedState("empty", [{ url: "**/api" }], [1]);

  const dummyResult = {
    status: "ok",
    viewport_metrics: {
      "390": {
        small_touch_target_count: 0,
        button_text_wrap_count: 0,
        low_contrast_count: 0,
        cls_score: 0.02,
        unlabeled_control_count: 0,
        missing_autocomplete_count: 0,
        th_without_scope_count: 0,
        numeric_cell_misaligned_count: 0,
        horizontal_overflow: false,
        stylesheets_applied: true,
      },
    },
  };
  const summary = buildDiagnosticsSummary(dummyResult, "standard");
  const craftChecksOk = summary.craft_checks.cls_compliant === true &&
    summary.craft_checks.form_controls_labeled === true &&
    summary.craft_checks.table_headers_scoped === true &&
    summary.craft_checks.numeric_cells_aligned === true;

  const results = {
    is_main_module_resolved: isMain,
    playwright_available: Boolean(pw),
    accesslint_cli_available: accesslintOk,
    accesslint_chrome_available: accesslintChromeOk,
    ui_ux_pro_max_available: searchPyExists,
    system_browser: sysBrowser,
    port_allocator_working: portOk,
    state_entry_truth_table: confState.confirmed && confMock.confirmed,
    craft_probes_pipeline: craftChecksOk,
    craft_health_index_working: summary.craft_health_index?.score >= 95 && summary.craft_health_index?.grade === "A+",
  };
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  const pass = results.is_main_module_resolved && results.playwright_available && results.accesslint_cli_available && results.accesslint_chrome_available && results.port_allocator_working && results.state_entry_truth_table && results.craft_probes_pipeline && results.craft_health_index_working;
  process.exit(pass ? 0 : 1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    return await runSelfTest();
  }

  let url = null;
  let outputDir = null;
  let viewports = ["320", "390", "1280"];
  let states = ["default"];
  let schemes = ["light"];
  let density = null;
  let forcedColors = "none";
  let contrast = "no-preference";
  let customManifest = null;
  let noManifest = false;
  let mockPath = null;
  let targetPath = null;
  let targetPlatform = "web";
  let runtime = "unknown";
  let sourceRevision = "unversioned";
  let serveCmd = null;
  let portArg = null;
  const dependencies = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--serve") {
      serveCmd = args[++i] || null;
    } else if (args[i] === "--port") {
      portArg = args[++i] || null;
    } else if (args[i] === "--target-path") {
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
    } else if (args[i] === "--mock") {
      mockPath = args[++i] || null;
    } else if (args[i] === "--output" || args[i] === "--out" || args[i] === "-o") {
      outputDir = args[++i];
    } else if (args[i] === "--target" || args[i] === "-t") {
      url = args[++i];
    } else if (args[i] === "--viewports" || args[i] === "-v") {
      viewports = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (args[i] === "--states" || args[i] === "-s") {
      states = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (args[i] === "--schemes") {
      schemes = (args[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = schemes.filter((s) => !["light", "dark"].includes(s));
      if (unknown.length) {
        process.stderr.write(`--schemes accepts light and/or dark (got: ${unknown.join(",")})\n`);
        process.exit(2);
      }
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

  let serverProcess = null;
  let allocatedPort = null;
  if (serveCmd) {
    if (!portArg || portArg === "auto") {
      allocatedPort = await findFreePort();
    } else {
      allocatedPort = parseInt(portArg, 10);
    }
    if (!url) {
      url = `http://127.0.0.1:${allocatedPort}`;
    } else {
      url = url.replace(/\{port\}|PORT/g, String(allocatedPort));
    }
  }

  if (!url || !outputDir) {
    process.stderr.write("Usage: node capture.mjs <url> --out <dir> [--viewports 320,390,1280] [--states default,stressed] [--mock mocks.json] [--serve <cmd>] [--port auto]\n");
    process.exit(1);
  }

  if (serveCmd) {
    const finalCmd = serveCmd.replace(/\{port\}|PORT/g, String(allocatedPort));
    serverProcess = spawn(finalCmd, {
      shell: true,
      stdio: "ignore",
      env: { ...process.env, PORT: String(allocatedPort) },
    });
    const ready = await waitForServer(url, 20000);
    if (!ready) {
      if (serverProcess && !serverProcess.killed) serverProcess.kill("SIGKILL");
      process.stderr.write(`--serve: timed out waiting for server at ${url}\n`);
      process.exit(2);
    }
  }

  try {
    let mocks = null;
    if (mockPath) {
      try {
        mocks = loadMocks(mockPath);
      } catch (error) {
        process.stderr.write(`--mock: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(2);
      }
    }

    fs.mkdirSync(outputDir, { recursive: true });

    // 1. Try Playwright
    let result = await captureWithPlaywright(url, outputDir, viewports, states, schemes, density,
                                             forcedColors, contrast, 4, mocks);

    // 2. Try System Browser CLI if Playwright unavailable. It cannot intercept
    // requests, so mock-driven states would screenshot the live data: refuse.
    if (!result && mocks) {
      process.stdout.write(JSON.stringify({
        status: "browser_unavailable",
        reason: "--mock requires Playwright; system browser CLI cannot intercept requests",
      }, null, 2) + "\n");
      process.exit(2);
    }
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
      requested: { schemes, density, forcedColors, contrast, mock: mockPath },
    };

    if (result) {
      const diagnostics_summary = buildDiagnosticsSummary(result);
      const metadata = buildCaptureMetadata(result, { ...metadataOptions, diagnostics_summary });
      const recording = recordHandoffEvidence(outputDir, result, metadata, {
        noManifest,
        manifestPath: customManifest,
      });
      process.stdout.write(JSON.stringify({ ...result, diagnostics_summary, metadata, evidence_record: recording }, null, 2) + "\n");
      // Mechanical craft gate: exit 3 when CHI < 90 so Stage 5 rework is
      // script-decidable (skill docs promise probe-based enforcement, not LLM
      // judgment). Probe-unmeasured capture keeps exit 0; its report already
      // marks unmeasured dims which reviewers must treat as gaps.
      const chiGate = diagnostics_summary?.craft_gate;
      if (chiGate && chiGate.passed === false) {
        process.exit(3);
      }
      process.exit(0);
    } else {
      const failure = {
        status: "browser_unavailable",
        reason: "No browser runner found (Playwright package or system Chrome/Chromium/Edge)",
        metadata: buildCaptureMetadata({ status: "browser_unavailable" }, metadataOptions),
      };
      process.stdout.write(JSON.stringify(failure, null, 2) + "\n");
      process.exit(2);
    }
  } finally {
    if (serverProcess && !serverProcess.killed) {
      try {
        process.kill(-serverProcess.pid, "SIGTERM");
      } catch {
        serverProcess.kill("SIGTERM");
      }
    }
  }
}

// Importable seam: the module is inert unless executed directly (`node capture.mjs`).
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  main();
}
