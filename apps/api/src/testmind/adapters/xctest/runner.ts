// apps/api/src/testmind/adapters/xctest/runner.ts
import type { TestRunner } from "../../core/adapter";

export const xctestRunner: TestRunner = {
  id: "xctest",
  async run(_cwd, _env, onLine) {
    onLine("[xctest] Runner not implemented (macOS tooling required)");
    return 1;
  },
};
