import { defineConfig } from "@playwright/test";
import path from "node:path";

const testDir = process.env.TM_TEST_DIR;
const livePreview = process.env.TM_LIVE_PREVIEW === "1";
const outputDir = process.env.PW_OUTPUT_DIR;
const allureResults = process.env.PW_ALLURE_RESULTS || "allure-results";
const jsonOutput =
  process.env.PW_JSON_OUTPUT || process.env.TM_JSON_OUTPUT || "report.json";
if (!testDir) {
  throw new Error("TM_TEST_DIR is required for AI runs");
}

export default defineConfig({
  testDir: path.resolve(testDir),
  testMatch: ["**/*.spec.{ts,js,mjs,cjs}", "**/*.test.{ts,js,mjs,cjs}"],
  outputDir: outputDir ? path.resolve(outputDir) : undefined,
  reporter: [
    ["json", { outputFile: path.resolve(jsonOutput) }],
    ["allure-playwright", { resultsDir: path.resolve(allureResults) }],
    ["line"],
  ],
  use: {
    baseURL: process.env.TM_BASE_URL || process.env.PW_BASE_URL || process.env.BASE_URL,
    headless: process.env.TM_HEADFUL === "1" ? false : true,
    screenshot: livePreview ? "on" : "only-on-failure",
    video: livePreview ? "on" : "retain-on-failure",
  },
});
