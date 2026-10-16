// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  blockingViolations,
  gateViolations,
  loadAllowlist,
  loadConfig,
  loadRegistry,
  type AxeViolation,
  type ScanResult,
  type Theme,
} from "./lib";

/**
 * Runs axe-core against every registered route in both themes. A serious or
 * critical violation that is not in a11y/allowlist.json fails the test. Raw
 * results are written to a11y-report/results for the report builder
 * (a11y/global-teardown.ts).
 */

const MOCK_PUBLIC_KEY = "GAXI4LZGQ7F3CKOBU7S6MFYKZRCNFRQVXJXKOMZ7GM7MIFST5W54AAAA";
const THEME_STORAGE_KEY = "remitmortgage-theme";
const RESULTS_DIR = path.resolve(__dirname, "..", "a11y-report", "results");
const AXE_SOURCE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const config = loadConfig();
const registry = loadRegistry();
const allowlist = loadAllowlist();

async function prepare(page: Page, theme: Theme) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  // Protected routes only check that a session cookie exists.
  await page.context().addCookies([{ name: "session", value: "a11y-scan", url: "http://localhost:3000" }]);
  await page.addInitScript(
    ({ key, value, publicKey }) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
      (window as unknown as Record<string, unknown>).freighterApi = {
        isConnected: async () => true,
        getPublicKey: async () => publicKey,
        signBlob: async (blob: string) => `mock_signature_${blob}`,
        requestAccess: async () => {},
        getNetwork: async () => "https://horizon-testnet.stellar.org",
        isAllowed: async () => true,
      };
    },
    { key: THEME_STORAGE_KEY, value: theme, publicKey: MOCK_PUBLIC_KEY },
  );
}

function slug(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

for (const theme of config.themes) {
  test.describe(`axe — ${theme} theme`, () => {
    for (const { route, url } of registry.routes) {
      test(`${route}`, async ({ page }, testInfo) => {
        await prepare(page, theme);
        await page.goto(url, { waitUntil: "load" });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
          /* long-polling pages never go idle; the load event is enough */
        });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        await page.evaluate(AXE_SOURCE);
        const violations = (await page.evaluate(
          async (tags) => {
            const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: unknown[] }> } }).axe;
            const { violations } = await axe.run(document, { runOnly: { type: "tag", values: tags } });
            return violations;
          },
          config.tags,
        )) as AxeViolation[];

        const result: ScanResult = { route, url, theme, violations };
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(RESULTS_DIR, `${theme}-${slug(route)}.json`), JSON.stringify(result, null, 2));
        await testInfo.attach(`axe-${theme}-${slug(route)}.json`, {
          body: JSON.stringify(violations, null, 2),
          contentType: "application/json",
        });

        const blocking = blockingViolations(gateViolations(result, config, allowlist));
        const summary = blocking
          .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length} node(s)) e.g. ${JSON.stringify(v.nodes[0]?.target)}`)
          .join("\n");
        expect(blocking, `New ${config.failOnImpacts.join("/")} accessibility violations on ${route} (${theme}):\n${summary}`).toEqual([]);
      });
    }
  });
}
