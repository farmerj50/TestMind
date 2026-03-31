export const FRAMEWORK_IDS = [
  "playwright-ts",
  "cucumber-js",
  "cypress-js",
  "appium-js",
  "xctest",
];

export const DEFAULT_FRAMEWORK_ID = "playwright-ts";

export function isFrameworkId(value) {
  return !!value && FRAMEWORK_IDS.includes(value);
}
