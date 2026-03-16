export const FRAMEWORK_IDS: readonly [
  "playwright-ts",
  "cucumber-js",
  "cypress-js",
  "appium-js",
  "xctest"
];

export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export const DEFAULT_FRAMEWORK_ID: FrameworkId;

export function isFrameworkId(value: string | null | undefined): value is FrameworkId;
