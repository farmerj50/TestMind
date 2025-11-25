import type { FastifyRequest } from "fastify";
import type { Integration, Prisma, Project } from "@prisma/client";
import githubIssuesProvider from "./providers/github";

export type IntegrationWithProject = Integration & { project: Project };

export interface IntegrationActionContext<TPayload = any> {
  req: FastifyRequest;
  integration: IntegrationWithProject;
  payload: TPayload;
  userId: string;
}

export interface IntegrationProvider {
  key: string;
  displayName: string;
  description?: string;
  allowMultiple?: boolean;
  validateConfig?(input: unknown): {
    config: Prisma.JsonValue;
    secrets?: Prisma.JsonValue;
  };
  maskConfig?(config: Prisma.JsonValue | null): Prisma.JsonValue | null;
  performAction?(
    action: string,
    ctx: IntegrationActionContext
  ): Promise<any>;
}

export const integrationProviders: Record<string, IntegrationProvider> = {
  "github-issues": githubIssuesProvider,
};

export function assertProvider(key: string): IntegrationProvider {
  const provider = integrationProviders[key];
  if (!provider) {
    throw new Error(`Unknown integration provider: ${key}`);
  }
  return provider;
}
