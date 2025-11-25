export type CoverageProfile = {
  statement?: number;
  branch?: number;
  decision?: number;
  edge?: number;
  security?: number;
  notes?: string;
};

export type AgentScenarioStep = {
  kind:
    | "goto"
    | "click"
    | "fill"
    | "expect-text"
    | "expect-visible"
    | "upload"
    | "custom";
  target?: string;
  value?: string;
  note?: string;
};

export type AgentScenarioPayload = {
  title: string;
  coverageType:
    | "statement"
    | "branch"
    | "edge"
    | "decision"
    | "security"
    | "regression"
    | "accessibility"
    | "other";
  description?: string;
  tags: string[];
  risk?: "low" | "medium" | "high";
  steps: AgentScenarioStep[];
};

export type PageAnalysisResult = {
  summary: string;
  coverage: CoverageProfile;
  scenarios: AgentScenarioPayload[];
};
