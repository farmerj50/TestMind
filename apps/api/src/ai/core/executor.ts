import type { SelfHealPayload } from "../../runner/queue.js";
import { buildAiExecutionContext } from "./context.js";
import type { AiExecutionContext } from "./types.js";

export async function executeAutonomousRepair<T>(input: {
  job: SelfHealPayload;
  run: (context: AiExecutionContext) => Promise<T>;
}) {
  const context = await buildAiExecutionContext(input.job);
  return input.run(context);
}
