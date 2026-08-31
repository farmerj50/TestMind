import test from "node:test";
import assert from "node:assert/strict";
import { parseZapJsonReport } from "./zap-scan.js";

test("parseZapJsonReport maps ZAP alerts into TestMind findings", () => {
  const findings = parseZapJsonReport(
    {
      site: [
        {
          "@name": "https://example.test",
          alerts: [
            {
              alert: "X-Frame-Options Header Not Set",
              riskcode: "2",
              riskdesc: "Medium (High)",
              confidence: "Medium",
              pluginid: "10020",
              desc: "<p>Missing anti-clickjacking response header.</p>",
              solution: "<p>Set X-Frame-Options or CSP frame-ancestors.</p>",
              instances: [
                {
                  uri: "https://example.test/",
                  method: "GET",
                  param: "",
                  evidence: "",
                },
              ],
            },
          ],
        },
      ],
    },
    "https://example.test",
    "baseline"
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].tool, "owasp-zap");
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[0].location, "https://example.test/");
  assert.equal((findings[0].evidence as any).scannerMode, "baseline");
  assert.equal((findings[0].evidence as any).owaspCategory, "A05:2021 Security Misconfiguration");
});

