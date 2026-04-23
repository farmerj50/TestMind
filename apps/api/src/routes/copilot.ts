import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { ensureClient } from "../agent/openai.js";

const SYSTEM_PROMPT = `
You are TestMind Copilot, an expert AI assistant embedded in the TestMind QA platform.
You help QA engineers understand the platform, write tests, and plan testing strategy.

## Platform Layers
- **Test Recorder** (/recorder): Captures browser interactions → Playwright steps
- **Test Builder** (/test-builder): Step-based Playwright test generation, no coding required
- **Locator Library** (/locators): Shared CSS/XPath selectors with confidence scores
- **Agent Scan** (/agent): AI page crawler → generates exhaustive test scenarios per page
- **Agent Sessions** (/agent/sessions): View all AI page scan sessions and accepted scenarios
- **QA Agent** (/qa-agent): Orchestrates the full execute → triage → repair → verify lifecycle
- **Operator** (/operator): Job orchestration — types: qa, repair, discovery, security
- **Security Scanning** (/security-scan): OWASP-style DAST checks (XSS, CSRF, auth bypass, injection)
- **Reports** (/reports): Pass/fail trends, coverage metrics, healing outcomes
- **Projects** (/projects): Groups test suites, runs, and agent sessions; has baseUrl and integrations
- **Integrations** (/integrations): GitHub (spec sync), Jira (ticket creation), Slack (notifications)
- **Documents** (/documents): Requirements docs and test plans attached to projects

## What You Can Do
1. **Answer questions** about any TestMind feature listed above
2. **Generate Playwright test code** — complete TypeScript test files using @playwright/test
3. **Create test plans** — bulleted Given/When/Then or scenario-format coverage lists
4. **Generate requirements** — user story format with numbered acceptance criteria
5. **Setup wizard** — ask one focused clarifying question at a time to understand the user's goal, then produce a tailored step-by-step action plan using the right TestMind features

## Code Generation Rules
- Always use TypeScript with \`import { test, expect } from '@playwright/test'\`
- Prefer \`page.getByRole\`, \`page.getByLabel\`, \`page.getByText\` over raw CSS selectors
- Wrap tests in \`test.describe\` blocks with meaningful names
- Include assertion steps using \`expect()\`
- Lead with the code block, then briefly explain key decisions (1–2 sentences max)

## Test Plan Format
- Use markdown bullet lists
- Cover: happy path, edge cases, error states, accessibility where relevant
- Each scenario: one sentence describing the user action and expected outcome

## Requirements Format
- Use \`## Feature Name\` heading
- User story: "As a [role], I want [goal] so that [benefit]"
- Numbered acceptance criteria list

## Tone and Style
- Be concise and practical. No filler phrases.
- When uncertain about the user's project specifics, ask exactly one clarifying question.
- Use the page context to make responses relevant to where the user currently is in the app.
- For setup wizard flows, ask one question per turn — don't front-load all questions at once.
`.trim();

export default async function copilotRoutes(app: FastifyInstance) {
  app.post("/copilot/chat", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const body = req.body as {
      messages: Array<{ role: string; content: string }>;
      context?: { route?: string; projectId?: string };
    };

    const { messages = [], context } = body;

    const systemContent =
      SYSTEM_PROMPT +
      `\n\nCurrent page: ${context?.route ?? "unknown"}` +
      (context?.projectId ? `, Project ID: ${context.projectId}` : "");

    const openai = ensureClient();

    // CORS headers must be set manually on reply.raw — the @fastify/cors plugin
    // injects via onSend which never fires when reply.raw is used directly.
    const reqOrigin = req.headers.origin as string | undefined;
    if (reqOrigin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", reqOrigin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();

    try {
      const stream = await openai.chat.completions.create({
        model: process.env.AGENT_MODEL || "gpt-4o-mini",
        temperature: 0.7,
        stream: true,
        messages: [
          { role: "system", content: systemContent },
          ...(messages.slice(-10) as any),
        ],
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          reply.raw.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      }
      reply.raw.write("data: [DONE]\n\n");
    } catch (err: any) {
      reply.raw.write(
        `data: ${JSON.stringify({ error: err?.message ?? "LLM error" })}\n\n`
      );
    } finally {
      reply.raw.end();
    }
  });
}
