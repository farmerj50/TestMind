import { z } from "zod";
import type { IntegrationProvider } from "../registry.js";

const ConfigSchema = z.object({
  notifyOn: z.enum(["all", "failures", "success"]).default("failures"),
});

const slackProvider: IntegrationProvider = {
  key: "slack-webhook",
  displayName: "Slack webhook",
  description: "Send run summaries to Slack via an incoming webhook.",
  validateConfig(input) {
    const parsed = ConfigSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    return { config: parsed.data };
  },
  maskConfig(config) {
    if (!config || typeof config !== "object") return config;
    return config;
  },
};

export default slackProvider;
