import type { NormalizedFailureArtifact } from "./types.js";

export type FailureArtifactWithPath = NormalizedFailureArtifact & { path: string };

export function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

export function hasArtifactPath(
  artifact: NormalizedFailureArtifact
): artifact is FailureArtifactWithPath {
  return typeof artifact.path === "string" && artifact.path.length > 0;
}
