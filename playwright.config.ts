import { defineConfig, devices } from "@playwright/test";

// Tests the built site on a server that sends no isolation headers, like GitHub Pages.
export default defineConfig({
  testDir: "tests",
  globalSetup: "./tests/build-fixtures.ts",
  timeout: 90_000,
  fullyParallel: true,
  workers: 3,
  reporter: "list",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "node tests/static-server.mjs dist 4173",
    url: "http://localhost:4173/ide/",
    reuseExistingServer: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
