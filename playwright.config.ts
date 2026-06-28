import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for EduSupervise e2e tests.
 *
 * Run against a local stack (docker compose up) or a deployed environment via
 * PLAYWRIGHT_BASE_URL. The smoke test in tests/e2e/smoke.spec.ts exercises the
 * full signup -> duty assignment -> reminder dispatch flow.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,           // sequential — smoke test creates shared resources
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "docker compose -f docker/docker-compose.yml up",
        url: "http://localhost:3000/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});