import { defineConfig, devices } from "@playwright/test";

// Axe accessibility regression suite (every route x light/dark theme).
// Run with `npm run test:a11y:axe`. Set A11Y_SKIP_SERVER=1 to scan a server
// that is already running (CI builds and starts one itself).
export default defineConfig({
  testDir: "./a11y",
  testMatch: /.*\.spec\.ts$/,
  globalTeardown: "./a11y/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  outputDir: "a11y-report/test-results",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "a11y-report/html" }],
    ["json", { outputFile: "a11y-report/results.json" }],
  ],
  use: {
    baseURL: "http://localhost:3000",
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.A11Y_SKIP_SERVER
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
        env: {
          ...(process.env as Record<string, string>),
          NEXT_PUBLIC_ADMIN_ADDRESS:
            process.env.NEXT_PUBLIC_ADMIN_ADDRESS ??
            "GAXI4LZGQ7F3CKOBU7S6MFYKZRCNFRQVXJXKOMZ7GM7MIFST5W54AAAA",
          NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
        },
      },
});
