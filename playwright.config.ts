import { defineConfig, devices } from "@playwright/test";

// E2E runs against a production build with Gemini forced off (UTSAV_DISABLE_GEMINI=1, even if .env.local has a key) (deterministic Demo Mode, so no real provider calls)
// and the local file store for shared guest links (UTSAV_STORE=file, isolated in .data-e2e/).
const PORT = Number(process.env.E2E_PORT ?? 3199);
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: { UTSAV_DISABLE_GEMINI: "1", UTSAV_STORE: "file", UTSAV_DATA_DIR: ".data-e2e", UTSAV_SILENT_LOGS: "1" },
  },
});
