import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { requestSpecHeal, requestSpecPatchOps } from "../../runner/llm.js";
import type { AiExecutionContext } from "./types.js";
import { resolveRepairConfigForFramework, type AiRepairConfig } from "./policy.js";
import {
  applyHealOperations,
  buildHealPromptPayload,
  containsNavTimeout,
  containsStrictMode,
  stripMarkdownCodeFence,
  type HealFixType,
  validateHealOperations,
  validatePatchedSpec,
  withTimeout,
} from "./repair-policy.js";

type RuleRepairResult = {
  kind: "rule";
  patchedSpec: string;
  summary: string;
  note: string;
  fixType: HealFixType;
  fixDetails?: Record<string, unknown>;
};

type LlmRepairResult = {
  kind: "llm";
  patchedSpec: string;
  summary: string;
  raw: string;
  prompt: ReturnType<typeof buildHealPromptPayload>;
  mode: "structured" | "full-rewrite";
  structuredFallbackReason: string | null;
  operationCount: number;
  operationTypes: string[];
};

export type RepairExecutionResult = RuleRepairResult | LlmRepairResult;

function normalizeNavigationUrl(raw: string) {
  try {
    const u = new URL(raw);
    let host = u.hostname;
    if (host.endsWith(".com.com")) host = host.replace(/\.com\.com$/, ".com");
    const tldFix = host.match(/\.([a-z]{2,3})\.com$/);
    if (tldFix) host = host.replace(/\.([a-z]{2,3})\.com$/, ".$1");
    if (host !== u.hostname) {
      u.hostname = host;
      return u.toString();
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function normalizeBaseUrl(raw?: string | null) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function containsConnectionRefused(message?: string | null) {
  if (!message) return false;
  return /ERR_CONNECTION_REFUSED|connection refused|net::ERR_CONNECTION_REFUSED/i.test(message);
}

function parseNavigateTargetFromTitle(title?: string | null) {
  if (!title) return null;
  const match = title.match(/^Navigate\s+(.+?)\s*(?:→|â†’|Ã¢â€ â€™)\s*(.+)$/i);
  if (!match) return null;
  const from = match[1]?.trim();
  const to = match[2]?.trim();
  if (!from || !to) return null;
  return { from, to };
}

function findSelectedTestBlock(specContent: string, title?: string | null) {
  if (!title) return null;
  const starts = [`test("${title}"`, `test('${title}'`, `test(\`${title}\``]
    .map((needle) => specContent.indexOf(needle))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b);
  const start = starts[0];
  if (start == null || start < 0) return null;
  const nextStart = specContent.indexOf("\n\ntest(", start + 1);
  const end = nextStart >= 0 ? nextStart : specContent.length;
  return {
    start,
    end,
    block: specContent.slice(start, end),
  };
}

function replaceSelectedTestBlock(
  specContent: string,
  selectedBlock: { start: number; end: number; block: string },
  nextBlock: string,
) {
  return `${specContent.slice(0, selectedBlock.start)}${nextBlock}${specContent.slice(selectedBlock.end)}`;
}

function parsePageSignals(snippet?: string) {
  if (!snippet) return null;
  try {
    const parsed = JSON.parse(snippet);
    const dom = parsed?.signals?.dom ?? parsed?.dom ?? {};
    const currentUrl = parsed?.signals?.url ?? parsed?.url ?? null;
    return {
      currentUrl: typeof currentUrl === "string" ? currentUrl : null,
      h1: typeof dom?.h1 === "string" ? dom.h1.trim() : "",
      title: typeof dom?.title === "string" ? dom.title.trim() : "",
      bodyText: typeof dom?.bodyText === "string" ? dom.bodyText.trim() : "",
    };
  } catch {
    return null;
  }
}

function normalizeRoutePath(raw?: string | null) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return u.pathname || "/";
    } catch {
      return null;
    }
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function tryRouteExpectationRepair(context: AiExecutionContext, specContent: string): RuleRepairResult | null {
  const transition = parseNavigateTargetFromTitle(context.failure.testTitle);
  if (!transition) return null;
  if (
    !context.evidence.failureClasses.includes("url_assertion") &&
    !context.evidence.failureClasses.includes("navigation_timeout")
  ) {
    return null;
  }

  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;

  const pageBranchPattern =
    /if \(rawText\.trim\(\)\.toLowerCase\(\) === "page"\) {\s*await expect\(page\)\.toHaveURL\(pathRegex\("([^"]+)"\), \{ timeout: 15000 \}\);\s*await ensurePageIdentity\(page, "([^"]+)"\);\s*return;\s*}/m;
  if (!pageBranchPattern.test(selectedBlock.block)) return null;

  const targetPath = transition.to.startsWith("/") ? transition.to : `/${transition.to}`;
  const nextBlock = selectedBlock.block.replace(
    pageBranchPattern,
    [
      'if (rawText.trim().toLowerCase() === "page") {',
      `        await expect(page).toHaveURL(pathRegex(${JSON.stringify(targetPath)}), { timeout: 15000 });`,
      `        await ensurePageIdentity(page, ${JSON.stringify(targetPath)});`,
      "        return;",
      "      }",
    ].join("\n"),
  );
  if (nextBlock === selectedBlock.block) return null;

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-corrected final route assertion to ${targetPath}`,
    note: "rule-based route-target",
    fixType: "rule_fixed",
    fixDetails: { rule: "route-target", from: transition.from, to: targetPath },
  };
}

function trySelectedTargetAssertionRepair(
  context: AiExecutionContext,
  specContent: string,
): RuleRepairResult | null {
  if (
    !context.evidence.failureClasses.includes("pathname_mismatch") &&
    !context.evidence.failureClasses.includes("url_assertion") &&
    !context.evidence.failureClasses.includes("navigation_timeout")
  ) {
    return null;
  }

  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;
  const transition = parseNavigateTargetFromTitle(context.failure.testTitle);
  const signals = parsePageSignals(context.evidence.pageSignalsSnippet);
  const desiredPath = normalizeRoutePath(transition?.to) || normalizeRoutePath(signals?.currentUrl);
  if (!desiredPath) return null;

  let nextBlock = selectedBlock.block;
  nextBlock = nextBlock.replace(
    /pathRegex\("([^"]+)"\)/g,
    `pathRegex(${JSON.stringify(desiredPath)})`,
  );
  nextBlock = nextBlock.replace(
    /ensurePageIdentity\(page, "([^"]+)"\)/g,
    `ensurePageIdentity(page, ${JSON.stringify(desiredPath)})`,
  );

  if (nextBlock === selectedBlock.block) return null;

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-aligned selected test URL and identity assertions to ${desiredPath}`,
    note: "rule-based selected-target-assertion",
    fixType: "rule_fixed",
    fixDetails: { rule: "selected-target-assertion", to: desiredPath },
  };
}

function tryConnectionRefusedBaseUrlRepair(
  context: AiExecutionContext,
  specContent: string,
): RuleRepairResult | null {
  const failureText = `${context.failure.message || ""}\n${context.failure.stderr || ""}\n${context.failure.stdout || ""}`;
  if (!containsConnectionRefused(failureText)) return null;

  const desiredBaseUrl = normalizeBaseUrl(context.job.baseUrl);
  if (!desiredBaseUrl) return null;

  const localhostPattern = /https?:\/\/localhost:\d+/g;
  if (!localhostPattern.test(specContent)) return null;

  const patchedSpec = specContent.replace(localhostPattern, desiredBaseUrl);
  if (patchedSpec === specContent) return null;

  return {
    kind: "rule",
    patchedSpec,
    summary: `Auto-replaced hardcoded localhost navigation with ${desiredBaseUrl}`,
    note: "rule-based base-url-fallback",
    fixType: "rule_fixed",
    fixDetails: { rule: "base-url-fallback", to: desiredBaseUrl },
  };
}

function tryVisibleIdentityRepair(context: AiExecutionContext, specContent: string): RuleRepairResult | null {
  if (
    !context.evidence.failureClasses.includes("role_locator_missing") &&
    !context.evidence.failureClasses.includes("missing_text_assertion")
  ) {
    return null;
  }

  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;
  const signals = parsePageSignals(context.evidence.pageSignalsSnippet);
  const suggestedText =
    signals?.h1 ||
    signals?.title ||
    "";
  if (!suggestedText) return null;

  let nextBlock = selectedBlock.block;
  nextBlock = nextBlock.replace(
    /const headingLocator = page\.getByRole\('heading', \{ name: '([^']+)' \}\);/m,
    `const headingLocator = page.getByRole('heading', { name: ${JSON.stringify(suggestedText)} });`,
  );
  nextBlock = nextBlock.replace(
    /const rawText = "([^"]+)";/m,
    `const rawText = ${JSON.stringify(suggestedText)};`,
  );
  nextBlock = nextBlock.replace(
    /await expect\(page\.getByText\(rawText\)\)\.toBeVisible\(\{ timeout: 10000 \}\);/m,
    [
      `await expect(page.getByRole('heading', { name: ${JSON.stringify(suggestedText)} })).toBeVisible({ timeout: 10000 });`,
    ].join("\n"),
  );

  if (nextBlock === selectedBlock.block) return null;

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-aligned visible identity assertion to '${suggestedText}'`,
    note: "rule-based visible-identity",
    fixType: "rule_fixed",
    fixDetails: { rule: "visible-identity", text: suggestedText },
  };
}

function tryIdentityMismatchFallbackRepair(
  context: AiExecutionContext,
  specContent: string,
): RuleRepairResult | null {
  if (!context.evidence.failureClasses.includes("identity_mismatch")) return null;
  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;
  const signals = parsePageSignals(context.evidence.pageSignalsSnippet);
  const suggestedText = signals?.h1 || signals?.title || "";
  if (!suggestedText) return null;

  const ensurePattern = /await ensurePageIdentity\(page, "([^"]+)"\);/m;
  if (!ensurePattern.test(selectedBlock.block)) return null;

  const nextBlock = selectedBlock.block.replace(
    ensurePattern,
    `await expect(page.getByRole('heading', { name: ${JSON.stringify(suggestedText)} })).toBeVisible({ timeout: IDENTITY_CHECK_TIMEOUT });`,
  );
  if (nextBlock === selectedBlock.block) return null;

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-replaced stale identity check with live heading '${suggestedText}'`,
    note: "rule-based identity-mismatch",
    fixType: "rule_fixed",
    fixDetails: { rule: "identity-mismatch", text: suggestedText },
  };
}

function tryNavigationLinkFallbackRepair(
  context: AiExecutionContext,
  specContent: string,
): RuleRepairResult | null {
  const transition = parseNavigateTargetFromTitle(context.failure.testTitle);
  if (!transition) return null;
  if (
    !context.evidence.failureClasses.includes("pathname_mismatch") &&
    !context.evidence.failureClasses.includes("navigation_timeout")
  ) {
    return null;
  }

  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;
  const targetPath = transition.to.startsWith("/") ? transition.to : `/${transition.to}`;
  const navigateCall = `await navigateTo(page, ${JSON.stringify(targetPath)});`;
  if (!selectedBlock.block.includes(navigateCall)) return null;

  const nextBlock = selectedBlock.block.replace(
    navigateCall,
    `await clickNavLink(page, ${JSON.stringify(targetPath)});`,
  );
  if (nextBlock === selectedBlock.block) return null;

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-switched navigation to shared nav-link flow for ${targetPath}`,
    note: "rule-based nav-link-fallback",
    fixType: "rule_fixed",
    fixDetails: { rule: "nav-link-fallback", to: targetPath },
  };
}

function tryMissingNavLocatorRepair(
  context: AiExecutionContext,
  specContent: string,
): RuleRepairResult | null {
  if (!context.evidence.failureClasses.includes("missing_locator_comment")) return null;
  const transition = parseNavigateTargetFromTitle(context.failure.testTitle);
  if (!transition) return null;
  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;
  const targetPath = transition.to.startsWith("/") ? transition.to : `/${transition.to}`;
  const missingLocatorPattern = /\/\/ Missing locator .* add it to shared locators and rerun generation\./m;
  if (!missingLocatorPattern.test(selectedBlock.block)) return null;

  const nextBlock = selectedBlock.block.replace(
    missingLocatorPattern,
    [
      `await clickNavLink(page, ${JSON.stringify(targetPath)});`,
      `      await expect(page).toHaveURL(pathRegex(${JSON.stringify(targetPath)}), { timeout: 15000 });`,
      `      await ensurePageIdentity(page, ${JSON.stringify(targetPath)});`,
    ].join("\n"),
  );
  if (nextBlock === selectedBlock.block) return null;

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-replaced missing nav locator with shared nav-link flow for ${targetPath}`,
    note: "rule-based missing-nav-locator",
    fixType: "rule_fixed",
    fixDetails: { rule: "missing-nav-locator", to: targetPath },
  };
}

function tryLocatorResolutionFallbackRepair(
  context: AiExecutionContext,
  specContent: string,
): RuleRepairResult | null {
  if (!context.evidence.failureClasses.includes("locator_resolution_failed")) return null;
  const transition = parseNavigateTargetFromTitle(context.failure.testTitle);
  if (!transition) return null;
  const targetPath = transition.to.startsWith("/") ? transition.to : `/${transition.to}`;
  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;
  if (!selectedBlock.block.includes("findFirstWorkingLocator(page, { candidates:")) return null;
  if (!selectedBlock.block.includes("await locator.click")) return null;
  if (!selectedBlock.block.includes('region: "navigation"')) return null;

  const candidatePattern =
    /findFirstWorkingLocator\(page, \{ candidates: \[([\s\S]*?)\], region: "navigation" \}\)/m;
  const match = selectedBlock.block.match(candidatePattern);
  if (!match) return null;
  const hrefCandidate = JSON.stringify(`a[href="${targetPath}"]`);
  if (match[1].includes(hrefCandidate)) return null;

  const nextBlock = selectedBlock.block.replace(
    candidatePattern,
    `findFirstWorkingLocator(page, { candidates: [$1, ${hrefCandidate}], region: "navigation" })`,
  );
  if (nextBlock === selectedBlock.block) return null;

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-added href locator fallback for ${targetPath}`,
    note: "rule-based locator-resolution-nav-fallback",
    fixType: "rule_fixed",
    fixDetails: { rule: "locator-resolution-nav-fallback", to: targetPath },
  };
}

function tryLoginSelectorRepair(context: AiExecutionContext, specContent: string): RuleRepairResult | null {
  if (!context.evidence.failureClasses.includes("login_selector_timeout")) return null;
  if (!/async function sharedLogin\(page: Page\)/.test(specContent)) return null;

  let patchedSpec = specContent;
  patchedSpec = patchedSpec.replace(
    /const userLocator = page\.locator\(SHARED_LOGIN_CONFIG\.usernameSelector\);/m,
    [
      "const userLocator = page",
      "  .locator(SHARED_LOGIN_CONFIG.usernameSelector)",
      "  .or(page.getByLabel(/email|user(name)?/i))",
      "  .or(page.getByPlaceholder(/email|user(name)?/i));",
    ].join("\n"),
  );
  patchedSpec = patchedSpec.replace(
    /const passLocator = page\.locator\(SHARED_LOGIN_CONFIG\.passwordSelector\);/m,
    [
      "const passLocator = page",
      "  .locator(SHARED_LOGIN_CONFIG.passwordSelector)",
      "  .or(page.getByLabel(/password/i))",
      "  .or(page.getByPlaceholder(/password/i));",
    ].join("\n"),
  );
  patchedSpec = patchedSpec.replace(
    /const submit = page\.locator\(SHARED_LOGIN_CONFIG\.submitSelector\);/m,
    [
      "const submit = page",
      "  .locator(SHARED_LOGIN_CONFIG.submitSelector)",
      "  .or(page.getByRole('button', { name: /log in|login|sign in|continue/i }));",
    ].join("\n"),
  );

  if (patchedSpec === specContent) return null;
  return {
    kind: "rule",
    patchedSpec,
    summary: "Auto-strengthened login selectors with label and placeholder fallbacks",
    note: "rule-based login-selector",
    fixType: "rule_fixed",
    fixDetails: { rule: "login-selector-fallbacks" },
  };
}

function tryMalformedSelectorRepair(context: AiExecutionContext, specContent: string): RuleRepairResult | null {
  if (!context.evidence.failureClasses.includes("css_selector_parse_error")) return null;
  if (!/function chooseLocator\(page: Page, selector: string, region\?: Region\)/.test(specContent)) {
    return null;
  }

  let patchedSpec = specContent;
  if (!/function sanitizeSelectorCandidate\(selector: string\)/.test(patchedSpec)) {
    patchedSpec = patchedSpec.replace(
      /function chooseLocator\(page: Page, selector: string, region\?: Region\) \{/m,
      [
        "function sanitizeSelectorCandidate(selector: string) {",
        "  const parts = selector.split(',').map((part) => part.trim()).filter(Boolean);",
        "  if (parts.length <= 1) return selector;",
        "  const safeParts = parts.filter((part) => {",
        "    if (!part.startsWith('#')) return true;",
        "    const idBody = part.slice(1);",
        "    return !/[\\s()]/.test(idBody);",
        "  });",
        "  return (safeParts.length ? safeParts : parts).join(', ');",
        "}",
        "",
        "function chooseLocator(page: Page, selector: string, region?: Region) {",
      ].join("\n"),
    );
  }
  patchedSpec = patchedSpec.replace(
    /const scope = regionScope\(page, region\);/m,
    [
      "const scope = regionScope(page, region);",
      "  const safeSelector = sanitizeSelectorCandidate(selector);",
    ].join("\n"),
  );
  patchedSpec = patchedSpec.replace(
    /const testId = getAttributeValue\(selector, 'data-testid'\);/m,
    "const testId = getAttributeValue(safeSelector, 'data-testid');",
  );
  patchedSpec = patchedSpec.replace(
    /const role = getAttributeValue\(selector, 'role'\);/m,
    "const role = getAttributeValue(safeSelector, 'role');",
  );
  patchedSpec = patchedSpec.replace(
    /const name = getAttributeValue\(selector, 'name'\);/m,
    "const name = getAttributeValue(safeSelector, 'name');",
  );
  patchedSpec = patchedSpec.replace(
    /return scope\.locator\(selector\);/m,
    "return scope.locator(safeSelector);",
  );

  if (patchedSpec === specContent) return null;
  return {
    kind: "rule",
    patchedSpec,
    summary: "Auto-sanitized malformed selector candidates before locator resolution",
    note: "rule-based selector-sanitize",
    fixType: "rule_fixed",
    fixDetails: { rule: "selector-sanitize" },
  };
}

function tryRuleBasedRepair(context: AiExecutionContext): RuleRepairResult | null {
  const specContent = context.specContent;
  if (!specContent) return null;

  const routeRepair = tryRouteExpectationRepair(context, specContent);
  if (routeRepair) return routeRepair;

  const targetAssertionRepair = trySelectedTargetAssertionRepair(context, specContent);
  if (targetAssertionRepair) return targetAssertionRepair;

  const missingNavLocatorRepair = tryMissingNavLocatorRepair(context, specContent);
  if (missingNavLocatorRepair) return missingNavLocatorRepair;

  const navLinkRepair = tryNavigationLinkFallbackRepair(context, specContent);
  if (navLinkRepair) return navLinkRepair;

  const identityMismatchRepair = tryIdentityMismatchFallbackRepair(context, specContent);
  if (identityMismatchRepair) return identityMismatchRepair;

  const identityRepair = tryVisibleIdentityRepair(context, specContent);
  if (identityRepair) return identityRepair;

  const locatorResolutionRepair = tryLocatorResolutionFallbackRepair(context, specContent);
  if (locatorResolutionRepair) return locatorResolutionRepair;

  const loginRepair = tryLoginSelectorRepair(context, specContent);
  if (loginRepair) return loginRepair;

  const malformedSelectorRepair = tryMalformedSelectorRepair(context, specContent);
  if (malformedSelectorRepair) return malformedSelectorRepair;

  const gotoMatch = specContent.match(/page\.goto\(\s*["']([^"']+)["']\s*\)/);
  const originalUrl = gotoMatch?.[1];

  if (originalUrl) {
    const fixed = normalizeNavigationUrl(originalUrl);
    if (fixed && fixed !== originalUrl) {
      let patchedSpec = specContent.replace(originalUrl, fixed);
      patchedSpec = patchedSpec.replace(
        /page\.goto\(\s*["'][^"']+["']\s*\)/,
        `page.goto(${JSON.stringify(fixed)}, { waitUntil: "domcontentloaded", timeout: 20000 })`
      );
      return {
        kind: "rule",
        patchedSpec,
        summary: "Auto-fixed navigation URL",
        note: "rule-based url fix",
        fixType: "rule_fixed",
        fixDetails: { rule: "url-fix" },
      };
    }
  }

  if (containsNavTimeout(context.failure.message)) {
    const gotoWithOpts = /page\.goto\(\s*([^,]+)\s*,\s*{[^}]*timeout\s*:\s*(\d+)/m;
    const gotoSimple = /page\.goto\(\s*([A-Za-z0-9_.$]+)\s*\)/m;
    let patchedSpec = specContent;
    let updated = false;

    const replaceWith = (urlLiteral: string) =>
      `page.goto(${urlLiteral.trim()}, { waitUntil: "domcontentloaded", timeout: 20000 })`;

    const mOpts = specContent.match(gotoWithOpts);
    if (mOpts) {
      const currentTimeout = Number(mOpts[2]);
      if (!Number.isNaN(currentTimeout) && currentTimeout < 10000) {
        patchedSpec = specContent.replace(gotoWithOpts, (_, urlLit) => replaceWith(urlLit));
        updated = true;
      }
    } else {
      const mSimple = specContent.match(gotoSimple);
      if (mSimple) {
        patchedSpec = specContent.replace(gotoSimple, (_, urlLit) => replaceWith(urlLit));
        updated = true;
      }
    }

    if (updated) {
      return {
        kind: "rule",
        patchedSpec,
        summary: "Auto-increased navigation timeout",
        note: "rule-based nav-timeout",
        fixType: "rule_fixed",
        fixDetails: { rule: "nav-timeout" },
      };
    }
  }

  if (containsStrictMode(context.failure.message)) {
    const hrefMatch = context.failure.message?.match(/href="([^"]+)"/);
    if (hrefMatch) {
      const href = hrefMatch[1];
      const locatorLinePattern =
        /(page\.(locator|getByRole|getByText|getByLabel|getByTestId|getByPlaceholder|getByAltText)\([^;]+?\))/m;
      const locatorMatch = specContent.match(locatorLinePattern);
      if (locatorMatch) {
        const original = locatorMatch[0];
        const patchedSpec = specContent.replace(original, `page.locator('a[href="${href}"]').first()`);
        return {
          kind: "rule",
          patchedSpec,
          summary: `Auto-fixed strict-mode locator via href=${href}`,
          note: "rule-based strict-mode href",
          fixType: "rule_fixed",
          fixDetails: { rule: "strict-mode-href", href },
        };
      }
    }

    const locatorPattern =
      /page\.(locator|getByRole|getByText|getByLabel|getByTestId|getByPlaceholder|getByAltText)\([^;]+?\)(?!\s*\.(first|nth|filter|locator))/m;
    const match = specContent.match(locatorPattern);
    if (match) {
      const target = match[0];
      const patchedSpec = specContent.replace(target, `${target}.first()`);
      return {
        kind: "rule",
        patchedSpec,
        summary: "Auto-selected first match for strict-mode locator",
        note: "rule-based strict-mode",
        fixType: "rule_fixed",
        fixDetails: { rule: "strict-mode-first" },
      };
    }
  }

  return null;
}

export async function executeRepairAttempt(input: {
  context: AiExecutionContext;
  projectId: string;
  adapterId?: string;
  config: AiRepairConfig;
}): Promise<RepairExecutionResult> {
  const { context, projectId, config } = input;
  const effectiveAdapterId = input.adapterId || DEFAULT_FRAMEWORK_ID;
  const effectiveConfig = resolveRepairConfigForFramework(config, effectiveAdapterId);
  if (!context.specContent) {
    throw new Error(`Spec file not found for ${context.repoRelativePath}`);
  }

  const connectionRefusedRule = tryConnectionRefusedBaseUrlRepair(context, context.specContent);
  if (connectionRefusedRule) {
    return connectionRefusedRule;
  }

  const ruleResult = tryRuleBasedRepair(context);
  if (ruleResult) {
    return ruleResult;
  }

  if (containsConnectionRefused(`${context.failure.message || ""}\n${context.failure.stderr || ""}\n${context.failure.stdout || ""}`)) {
    throw new Error("Infra-like connection failure did not match a safe repair rule");
  }

  const buildPromptPayload = (previousAttemptRejectedReason?: string | null) => ({
    ...buildHealPromptPayload(projectId, context),
    previousAttemptRejectedReason,
  });
  let healedSummary = "";
  let healedRaw = "";
  let patchedSpec = "";
  let healMode: "structured" | "full-rewrite" = "full-rewrite";
  let structuredFallbackReason: string | null = null;
  let operationTypes: string[] = [];
  let operationCount = 0;
  const healStartedAt = Date.now();
  const remainingBudgetMs = () =>
    Math.max(0, effectiveConfig.totalTimeoutMs - (Date.now() - healStartedAt));
  let lastRejectedReason: string | null = null;

  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    patchedSpec = "";
    healedSummary = "";
    healedRaw = "";
    healMode = "full-rewrite";
    structuredFallbackReason = null;
    operationTypes = [];
    operationCount = 0;

    const promptPayload = buildPromptPayload(lastRejectedReason);
    const forceStructuredRetry = attemptIndex > 0 && effectiveConfig.structuredPatch;

    if (effectiveConfig.structuredPatch) {
      try {
        const structuredBudget = Math.max(5000, Math.min(effectiveConfig.structuredTimeoutMs, remainingBudgetMs()));
        const patchResult = await withTimeout(requestSpecPatchOps({ ...promptPayload, timeoutMs: structuredBudget }), structuredBudget);
        const opValidation = validateHealOperations(patchResult.operations, {
          maxOps: effectiveConfig.maxPatchOps,
          maxText: effectiveConfig.maxPatchText,
        });
        if (opValidation) {
          throw new Error(`Structured patch validation failed: ${opValidation}`);
        }
        patchedSpec = applyHealOperations(context.specContent, patchResult.operations);
        healedSummary = patchResult.summary;
        healedRaw = patchResult.raw;
        operationCount = patchResult.operations.length;
        operationTypes = patchResult.operations.map((op) => op.type);
        healMode = "structured";
      } catch (structuredErr) {
        structuredFallbackReason =
          structuredErr instanceof Error ? structuredErr.message : String(structuredErr);
        if (forceStructuredRetry || !effectiveConfig.allowFullRewriteFallback) {
          throw structuredErr;
        }
      }
    }

    if (!patchedSpec) {
      const budget = remainingBudgetMs();
      if (budget <= 0) {
        throw new Error(`self-heal timeout after ${effectiveConfig.totalTimeoutMs}ms`);
      }
      const healResult = await withTimeout(requestSpecHeal({ ...promptPayload, timeoutMs: budget }), budget);
      patchedSpec = healResult.updatedSpec;
      healedSummary = healResult.summary;
      healedRaw = healResult.raw;
    }

    patchedSpec = stripMarkdownCodeFence(patchedSpec);
    const validationError = validatePatchedSpec(context.specContent, patchedSpec, effectiveAdapterId, {
      maxChangedLines: effectiveConfig.maxChangedLines,
      maxBytesDelta: effectiveConfig.maxBytesDelta,
    });
    if (!validationError) {
      return {
        kind: "llm",
        patchedSpec,
        summary: healedSummary,
        raw: healedRaw,
        prompt: promptPayload,
        mode: healMode,
        structuredFallbackReason,
        operationCount,
        operationTypes,
      };
    }

    lastRejectedReason = validationError;
    if (attemptIndex >= 1 || remainingBudgetMs() < 5000) {
      throw new Error(`Self-heal patch validation failed: ${validationError}`);
    }
  }

  throw new Error(`Self-heal patch validation failed: ${lastRejectedReason ?? "unknown validation error"}`);
}
