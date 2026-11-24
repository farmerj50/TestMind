// Autonomous Development Mode's "self-improvement" find-work heuristic. Adapts
// selectWorkflowRisk's existing gap-selection approach (apps/api/src/lib/workflow-risk.ts) -
// routes/areas with no mapped test coverage - into a short natural-language instruction
// string, rather than inventing a new heuristic from scratch.
import { getApplicationBrainSnapshot } from "./application-brain-query.js";
import { selectWorkflowRisk } from "./workflow-risk.js";

const DEFAULT_MAX_WORKFLOWS = 10;
const DEFAULT_MAX_TESTS = 50;

export async function generateSelfImprovementInstruction(projectId: string, now: string = new Date().toISOString()): Promise<string> {
  const snapshot = await getApplicationBrainSnapshot(projectId);
  const selection = selectWorkflowRisk(snapshot, now, DEFAULT_MAX_WORKFLOWS, DEFAULT_MAX_TESTS);

  const lines: string[] = [];
  if (selection.proposedTests.length) {
    lines.push(
      `Routes with no mapped test coverage: ${selection.proposedTests.map((p) => p.route).join(", ")}. ` +
        `Investigate these routes, add missing tests, and fix any bugs the new tests surface.`
    );
  }
  if (selection.selected.length) {
    const top = selection.selected.slice(0, 5).map((w: any) => w.id ?? w.workflowId ?? String(w)).join(", ");
    lines.push(`Highest-risk existing workflows to review for regressions or flakiness: ${top}.`);
  }
  if (!lines.length) {
    return "No specific coverage gaps or high-risk workflows were found. Review recent test failures and improve test reliability where possible.";
  }
  return lines.join(" ");
}

// mode: 'both' combines the caller's own instruction with the generated one, clearly
// delimited - never silently picking one over the other.
export async function buildInstructionText(
  mode: "assigned" | "selfImprovement" | "both",
  projectId: string,
  callerInstructionText: string | null | undefined
): Promise<string | null> {
  if (mode === "assigned") return callerInstructionText ?? null;

  const generated = await generateSelfImprovementInstruction(projectId);
  if (mode === "selfImprovement") return generated;

  // mode === 'both'
  const parts: string[] = [];
  if (callerInstructionText) parts.push(`## Assigned task\n${callerInstructionText}`);
  parts.push(`## Self-improvement\n${generated}`);
  return parts.join("\n\n");
}
