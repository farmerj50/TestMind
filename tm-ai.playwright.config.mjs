import { defineConfig } from "@playwright/test";
import path from "node:path";

const testDir = process.env.TM_TEST_DIR;
const jsonOutput =
  process.env.PW_JSON_OUTPUT || process.env.TM_JSON_OUTPUT || "report.json";
if (!testDir) {
  throw new Error("TM_TEST_DIR is required for AI runs");
}

export default defineConfig({
  testDir: path.resolve(testDir),
  testMatch: ["**/*.spec.{ts,js,mjs,cjs}", "**/*.test.{ts,js,mjs,cjs}"],
  reporter: [
    ["json", { outputFile: path.resolve(jsonOutput) }],
    ["line"],
  ],
  use: {
    baseURL: process.env.TM_BASE_URL || process.env.PW_BASE_URL || process.env.BASE_URL,
    headless: process.env.TM_HEADFUL === "1" ? false : true,
  },
});
