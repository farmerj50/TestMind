import { z } from "zod";
import type { IntegrationProvider } from "../registry.js";

const ConfigSchema = z.object({
  recipients: z.array(z.string().email()).default([]),
  notifyOn: z.enum(["all", "failures", "success"]).default("failures"),
});

const emailProvider: IntegrationProvider = {
  key: "email-smtp",
  displayName: "Email (SMTP)",
  description: "Send run summaries via SMTP to configured recipients.",
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

export default emailProvider;
