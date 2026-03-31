import { DEFAULT_FRAMEWORK_ID, FRAMEWORK_IDS, isFrameworkId } from "./framework.js";

export const FRAMEWORK_REGISTRY = {
  "playwright-ts": {
    id: "playwright-ts",
    label: "Playwright",
    fileExtensions: [".spec.ts", ".spec.js"],
    previewMode: "code",
    resultKind: "spec",
    capabilities: {
      supportsAllure: true,
      supportsLocatorHealth: true,
      supportsNavSuggestions: true,
      supportsSelfHeal: true,
      supportsLivePreview: true,
    },
  },
  "cucumber-js": {
    id: "cucumber-js",
    label: "Cucumber",
    fileExtensions: [".feature"],
    previewMode: "gherkin",
    resultKind: "scenario",
    capabilities: {
      supportsAllure: false,
      supportsLocatorHealth: true,
      supportsNavSuggestions: true,
      supportsSelfHeal: true,
      supportsLivePreview: false,
    },
  },
  "cypress-js": {
    id: "cypress-js",
    label: "Cypress",
    fileExtensions: [".cy.ts", ".cy.js"],
    previewMode: "code",
    resultKind: "spec",
    capabilities: {
      supportsAllure: false,
      supportsLocatorHealth: false,
      supportsNavSuggestions: false,
      supportsSelfHeal: false,
      supportsLivePreview: false,
    },
  },
  "appium-js": {
    id: "appium-js",
    label: "Appium",
    fileExtensions: [".spec.js"],
    previewMode: "code",
    resultKind: "spec",
    capabilities: {
      supportsAllure: false,
      supportsLocatorHealth: false,
      supportsNavSuggestions: false,
      supportsSelfHeal: false,
      supportsLivePreview: false,
    },
  },
  "xctest": {
    id: "xctest",
    label: "XCTest",
    fileExtensions: [".swift"],
    previewMode: "code",
    resultKind: "suite",
    capabilities: {
      supportsAllure: false,
      supportsLocatorHealth: false,
      supportsNavSuggestions: false,
      supportsSelfHeal: false,
      supportsLivePreview: false,
    },
  },
};

export function getFrameworkDefinition(id) {
  if (id && isFrameworkId(id)) {
    return FRAMEWORK_REGISTRY[id];
  }
  return FRAMEWORK_REGISTRY[DEFAULT_FRAMEWORK_ID];
}

export function hasFrameworkCapability(id, capability) {
  return getFrameworkDefinition(id).capabilities[capability];
}

export function matchFrameworkIdFromValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return undefined;
  if (isFrameworkId(normalized)) return normalized;

  const generatedMatch = normalized.match(/^Generated \((.+)\)$/);
  if (generatedMatch?.[1] && isFrameworkId(generatedMatch[1])) {
    return generatedMatch[1];
  }

  return FRAMEWORK_IDS.find(
    (frameworkId) => normalized === frameworkId || normalized.startsWith(`${frameworkId}-`)
  );
}

export function listFrameworkDefinitions() {
  return FRAMEWORK_IDS.map((frameworkId) => FRAMEWORK_REGISTRY[frameworkId]);
}
