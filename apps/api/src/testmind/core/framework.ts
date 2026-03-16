export const FRAMEWORK_IDS = [
  "playwright-ts",
  "cucumber-js",
  "cypress-js",
  "appium-js",
  "xctest",
] as const;

export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export const DEFAULT_FRAMEWORK_ID: FrameworkId = "playwright-ts";

export function isFrameworkId(value: string | null | undefined): value is FrameworkId {
  return !!value && (FRAMEWORK_IDS as readonly string[]).includes(value);
}
