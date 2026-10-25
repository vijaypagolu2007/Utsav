import { defineConfig, devices } from "@playwright/test";

// E2E runs against a production build with Gemini forced off (UTSAV_DISABLE_GEMINI=1, even if .env.local has a key) (deterministic Demo Mode, so no real provider calls)
// and the local file store for shared guest links (UTSAV_STORE=file, isolated in .data-e2e/).
// Firebase is never configured here (the empty values below win over a developer's .env.local, since Next never
// overrides a variable already present in the environment): NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK=1 only lets e2e/cloud.spec.ts stand in a fake auth
// module (window.__UTSAV_AUTH_MOCK__) and mock /api/cloud/*; production builds don't set it.
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
    env: { NEXT_PUBLIC_UTSAV_E2E_AUTH_MOCK: "1", UTSAV_DISABLE_GEMINI: "1", UTSAV_STORE: "file", UTSAV_DATA_DIR: ".data-e2e", UTSAV_SILENT_LOGS: "1",
      NEXT_PUBLIC_FIREBASE_API_KEY: "", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "", NEXT_PUBLIC_FIREBASE_APP_ID: "" },
  },
});
