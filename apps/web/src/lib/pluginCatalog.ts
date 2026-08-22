import type { FrameworkId } from "@testmind/core/framework";

export type PluginStatus = "available" | "installed" | "connected" | "configured";

export type PluginCategory = "Testing" | "CI/CD" | "Quality / DevOps" | "AI / Security";

export type PluginIconKey =
  | "framework"
  | "github"
  | "git"
  | "jenkins"
  | "jira"
  | "docker"
  | "ai"
  | "security";

export type PluginDefinition = {
  id: string;
  name: string;
  category: PluginCategory;
  description: string;
  route: string;
  icon: PluginIconKey;
  docsUrl?: string;
  frameworkId?: FrameworkId;
  providerKey?: string;
  secretKeys?: string[];
  statusHint?: "github-oauth" | "openai" | "security";
  actionVerb?: "Configure" | "Connect" | "Enable" | "Open";
};

export const PLUGIN_CATEGORIES: PluginCategory[] = [
  "Testing",
  "CI/CD",
  "Quality / DevOps",
  "AI / Security",
];

export const pluginCatalog: PluginDefinition[] = [
  {
    id: "playwright",
    name: "Playwright",
    category: "Testing",
    description: "Generate, execute, self-heal, and inspect Playwright tests.",
    route: "/dashboard",
    icon: "framework",
    frameworkId: "playwright-ts",
    docsUrl: "https://playwright.dev/docs/intro",
    actionVerb: "Enable",
  },
  {
    id: "cucumber",
    name: "Cucumber",
    category: "Testing",
    description: "Author and run Gherkin scenarios through the Cucumber adapter.",
    route: "/suite",
    icon: "framework",
    frameworkId: "cucumber-js",
    docsUrl: "https://cucumber.io/docs/cucumber/",
    actionVerb: "Enable",
  },
  {
    id: "cypress",
    name: "Cypress",
    category: "Testing",
    description: "Parse Cypress failures and run Cypress specs from TestMind workflows.",
    route: "/suite",
    icon: "framework",
    frameworkId: "cypress-js",
    docsUrl: "https://docs.cypress.io",
    actionVerb: "Enable",
  },
  {
    id: "appium",
    name: "Appium",
    category: "Testing",
    description: "Generate and execute mobile automation through the Appium adapter.",
    route: "/suite",
    icon: "framework",
    frameworkId: "appium-js",
    docsUrl: "https://appium.io/docs/en/latest/",
    actionVerb: "Enable",
  },
  {
    id: "github",
    name: "GitHub",
    category: "CI/CD",
    description: "Connect repositories and file issues from failed runs.",
    route: "/dashboard",
    icon: "github",
    providerKey: "github-issues",
    statusHint: "github-oauth",
    docsUrl: "https://docs.github.com/en",
    actionVerb: "Connect",
  },
  {
    id: "gitlab",
    name: "GitLab",
    category: "CI/CD",
    description: "Use TestMind CI webhooks from GitLab pipelines.",
    route: "/integrations",
    icon: "git",
    docsUrl: "https://docs.gitlab.com/ci/",
    actionVerb: "Configure",
  },
  {
    id: "jenkins",
    name: "Jenkins",
    category: "CI/CD",
    description: "Trigger TestMind workflows from Jenkins jobs and pipelines.",
    route: "/integrations",
    icon: "jenkins",
    providerKey: "jenkins",
    secretKeys: ["jenkins_api_token"],
    docsUrl: "https://www.jenkins.io/doc/",
    actionVerb: "Configure",
  },
  {
    id: "azure-devops",
    name: "Azure DevOps",
    category: "CI/CD",
    description: "Use TestMind CI webhook snippets from Azure DevOps pipelines.",
    route: "/integrations",
    icon: "git",
    docsUrl: "https://learn.microsoft.com/azure/devops/pipelines/",
    actionVerb: "Configure",
  },
  {
    id: "jira",
    name: "Jira",
    category: "Quality / DevOps",
    description: "Sync requirements and trace generated coverage to Jira issues.",
    route: "/integrations",
    icon: "jira",
    docsUrl: "https://support.atlassian.com/jira-cloud-administration/",
    actionVerb: "Configure",
  },
  {
    id: "docker",
    name: "Docker",
    category: "Quality / DevOps",
    description: "Run TestMind API, workers, and CI runners in containerized environments.",
    route: "/documents",
    icon: "docker",
    docsUrl: "https://docs.docker.com/",
    actionVerb: "Open",
  },
  {
    id: "openai",
    name: "OpenAI",
    category: "AI / Security",
    description: "Power page analysis, generated tests, repair, and triage workflows.",
    route: "/integrations",
    icon: "ai",
    secretKeys: ["OPENAI_API_KEY", "OPEN_API_KEY"],
    statusHint: "openai",
    docsUrl: "https://platform.openai.com/docs",
    actionVerb: "Configure",
  },
  {
    id: "security-tools",
    name: "Security tools",
    category: "AI / Security",
    description: "Configure auth profiles, API fixtures, OWASP checks, and baselines.",
    route: "/security-scan",
    icon: "security",
    statusHint: "security",
    providerKey: "security_test_setup",
    actionVerb: "Configure",
  },
];
