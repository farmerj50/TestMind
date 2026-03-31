import type { TestPlan } from "../../core/plan.js";

export const xctestAdapter = {
  id: "xctest",
  render(_plan: TestPlan) {
    return [
      {
        path: "README.txt",
        content:
          "XCTest generation is placeholder. Swift generation and xcodebuild integration needed.\n",
      },
    ];
  },
  manifest(_plan: TestPlan) {
    return { pages: [], count: 0 };
  },
};
