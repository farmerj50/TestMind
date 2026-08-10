import type { Monaco } from "@monaco-editor/react";

// Minimal declaration stubs so Monaco understands the TestMind spec environment
// without access to node_modules. Semantic validation is disabled (see below),
// so these stubs exist purely to power hover tooltips and autocomplete.
const SPEC_ENV_DECLARATIONS = `
declare module "node:path" {
  function join(...paths: string[]): string;
  function resolve(...paths: string[]): string;
  function dirname(p: string): string;
  function basename(p: string, ext?: string): string;
  export { join, resolve, dirname, basename };
}
declare module "node:fs/promises" {
  function readFile(path: string, encoding: "utf8"): Promise<string>;
  function writeFile(path: string, data: string): Promise<void>;
  function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export { readFile, writeFile, mkdir };
}
declare module "@playwright/test" {
  interface Page {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
    locator(selector: string, options?: { has?: Locator; hasText?: string }): Locator;
    waitForSelector(selector: string, options?: { state?: string; timeout?: number }): Promise<void>;
    waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
    url(): string;
    title(): Promise<string>;
    screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
    evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
    close(): Promise<void>;
  }
  interface Locator {
    click(options?: { timeout?: number; force?: boolean }): Promise<void>;
    fill(value: string, options?: { timeout?: number }): Promise<void>;
    type(text: string, options?: { delay?: number }): Promise<void>;
    press(key: string): Promise<void>;
    textContent(options?: { timeout?: number }): Promise<string | null>;
    innerText(options?: { timeout?: number }): Promise<string>;
    getAttribute(name: string, options?: { timeout?: number }): Promise<string | null>;
    isVisible(options?: { timeout?: number }): Promise<boolean>;
    isEnabled(options?: { timeout?: number }): Promise<boolean>;
    waitFor(options?: { state?: string; timeout?: number }): Promise<void>;
    first(): Locator;
    last(): Locator;
    nth(index: number): Locator;
    filter(options?: { hasText?: string | RegExp }): Locator;
  }
  interface TestInfo {
    outputDir: string;
    title: string;
    status?: string;
    annotations: Array<{ type: string; description?: string }>;
    attach(name: string, options?: { path?: string; body?: string | Buffer; contentType?: string }): Promise<void>;
  }
  interface TestFunction {
    (title: string, fn: (args: { page: Page }, testInfo: TestInfo) => Promise<void>): void;
    (title: string, options: { timeout?: number }, fn: (args: { page: Page }, testInfo: TestInfo) => Promise<void>): void;
    step(title: string, fn: () => Promise<void>): Promise<void>;
    skip(condition?: boolean, message?: string): void;
    slow(): void;
    setTimeout(timeout: number): void;
    info(): TestInfo;
    describe(title: string, fn: () => void): void;
    beforeAll(fn: (args: { page: Page }) => Promise<void>): void;
    afterAll(fn: (args: { page: Page }) => Promise<void>): void;
    beforeEach(fn: (args: { page: Page }) => Promise<void>): void;
    afterEach(fn: (args: { page: Page }) => Promise<void>): void;
  }
  interface ExpectResult {
    toBeVisible(options?: { timeout?: number }): Promise<void>;
    toBeHidden(options?: { timeout?: number }): Promise<void>;
    toBeEnabled(options?: { timeout?: number }): Promise<void>;
    toBeDisabled(options?: { timeout?: number }): Promise<void>;
    toContainText(text: string | RegExp, options?: { timeout?: number }): Promise<void>;
    toHaveText(text: string | RegExp, options?: { timeout?: number }): Promise<void>;
    toHaveValue(value: string): Promise<void>;
    toHaveURL(url: string | RegExp): Promise<void>;
    toHaveTitle(title: string | RegExp): Promise<void>;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    not: ExpectResult;
  }
  function expect(value: unknown): ExpectResult;
  const test: TestFunction;
  export { test, expect, Page, Locator, TestInfo };
}

// TestMind runtime helpers — defined inline in every generated spec but
// hidden from the editor by splitSpecForEditor(). Declared here so Monaco
// shows hover types and autocomplete for them.
declare function navigateTo(page: import("@playwright/test").Page, target: string): Promise<void>;
declare function ensurePageIdentity(page: import("@playwright/test").Page, target: string): Promise<void>;
declare function captureStepArtifact(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo, stepTitle: string): Promise<void>;
declare function findFirstWorkingLocator(page: import("@playwright/test").Page, resolution: unknown): Promise<import("@playwright/test").Locator | null>;
declare function sharedLogin(page: import("@playwright/test").Page): Promise<void>;
declare function clickNavLink(page: import("@playwright/test").Page, target: string): Promise<void>;
declare function attachPageSignals(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo): void;
declare function snapshotSignals(page: import("@playwright/test").Page): Promise<Record<string, unknown>>;
declare function writeSignals(testInfo: import("@playwright/test").TestInfo, signals: Record<string, unknown>): Promise<void>;
declare function startLivePreview(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo): void;
`;

let configured = false;

export function configureSpecEditor(monaco: Monaco): void {
  if (configured) return;
  configured = true;

  // Disable semantic validation so Monaco doesn't complain about unresolvable
  // npm packages (node:fs, @playwright/test) that exist on the server but not
  // in the browser's language service. Syntax validation stays on so genuinely
  // malformed code (missing braces, etc.) still shows an error.
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });

  // Inject type stubs so hover tooltips and autocomplete work for the
  // Playwright API surface and TestMind helpers.
  monaco.languages.typescript.typescriptDefaults.addExtraLib(
    SPEC_ENV_DECLARATIONS,
    "testmind://testmind-spec-env.d.ts"
  );
}
