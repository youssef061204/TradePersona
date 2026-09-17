import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node ../backend/index.js",
      url: "http://localhost:3001/healthz",
      env: {
        PORT: "3001",
        CORS_ORIGINS: "http://localhost:3000",
        ENABLE_GEMINI: "false",
        ENABLE_AGGREGATE_ANALYTICS: "false",
      },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run start -- --port 3000",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
