import type { FrameworkId } from "./framework";

export type FrameworkCapabilities = {
  supportsAllure: boolean;
  supportsLocatorHealth: boolean;
  supportsNavSuggestions: boolean;
  supportsSelfHeal: boolean;
  supportsLivePreview: boolean;
};

export type FrameworkDefinition = {
  id: FrameworkId;
  label: string;
  fileExtensions: string[];
  previewMode: "code" | "gherkin";
  resultKind: "spec" | "scenario" | "suite";
  capabilities: FrameworkCapabilities;
};

export declare const FRAMEWORK_REGISTRY: Record<FrameworkId, FrameworkDefinition>;

export declare function getFrameworkDefinition(id?: string | null): FrameworkDefinition;
export declare function hasFrameworkCapability(
  id: string | null | undefined,
  capability: keyof FrameworkCapabilities
): boolean;
export declare function matchFrameworkIdFromValue(value?: string | null): FrameworkId | undefined;
export declare function listFrameworkDefinitions(): FrameworkDefinition[];
