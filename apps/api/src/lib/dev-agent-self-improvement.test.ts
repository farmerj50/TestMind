import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { buildInstructionText, generateSelfImprovementInstruction } from "./dev-agent-self-improvement.js";

// index.ts can't be booted from a test (same constraint as evaluations-datasets.test.ts) -
// exercises the real heuristic against a real local project's application model.

const prisma = new PrismaClient();

test("mode 'assigned' returns the caller's own instruction text unchanged, never generates anything", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const result = await buildInstructionText("assigned", project!.id, "Fix the flaky login test.");
  assert.equal(result, "Fix the flaky login test.");
});

test("mode 'assigned' with no caller text returns null, not an empty-string placeholder", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const result = await buildInstructionText("assigned", project!.id, undefined);
  assert.equal(result, null);
});

test("generateSelfImprovementInstruction always returns a non-empty string, even with no coverage gaps found", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const result = await generateSelfImprovementInstruction(project!.id);
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0);
});

test("mode 'selfImprovement' returns the generated instruction, not the caller's own text", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const generated = await generateSelfImprovementInstruction(project!.id);
  const result = await buildInstructionText("selfImprovement", project!.id, "This caller text must be ignored in this mode.");
  assert.equal(result, generated);
  assert.ok(!result?.includes("This caller text must be ignored in this mode."));
});

test("mode 'both' combines the caller's instruction and the generated one, clearly delimited - never silently picks one", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const result = await buildInstructionText("both", project!.id, "Assigned: add a logout button.");
  assert.ok(result?.includes("Assigned: add a logout button."), "caller's own instruction must be present");
  assert.ok(result?.includes("## Assigned task"), "must be labeled, not concatenated silently");
  assert.ok(result?.includes("## Self-improvement"), "generated portion must be labeled, not concatenated silently");
});

test("mode 'both' with no caller instruction omits the assigned-task section entirely", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const result = await buildInstructionText("both", project!.id, undefined);
  assert.ok(!result?.includes("## Assigned task"));
  assert.ok(result?.includes("## Self-improvement"));
});
