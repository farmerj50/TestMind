import test from "node:test";
import assert from "node:assert/strict";
import {
  detectDirectoryListing,
  extractHttpMethodFindings,
  extractServiceExposureFindings,
  extractVersionDisclosureFindings,
  fingerprintServiceFromBanner,
  parseAllowedMethods,
} from "./security-heuristics.js";

test("extractVersionDisclosureFindings flags server and framework headers", () => {
  const findings = extractVersionDisclosureFindings({
    headers: {
      server: "nginx/1.25.4",
      "x-powered-by": "Express",
    },
    location: "https://example.com",
    tool: "header-check",
  });

  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.title, "Server banner disclosed");
  assert.equal(findings[0]?.severity, "low");
  assert.equal(findings[1]?.title, "Technology stack disclosed");
});

test("parseAllowedMethods normalizes and deduplicates methods", () => {
  assert.deepEqual(parseAllowedMethods("GET, post, TRACE, get"), ["GET", "POST", "TRACE"]);
});

test("extractHttpMethodFindings flags TRACE and risky methods", () => {
  const findings = extractHttpMethodFindings({
    allowHeader: "GET, POST, TRACE, PUT",
    location: "https://example.com",
    tool: "dast-options",
  });

  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.title, "TRACE/TRACK method enabled");
  assert.equal(findings[1]?.title, "Potentially risky HTTP methods exposed");
});

test("detectDirectoryListing recognizes index pages", () => {
  const findings = detectDirectoryListing({
    body: "<html><title>Index of /backup</title><body></body></html>",
    location: "https://example.com/backup/",
    tool: "dast-dirlist",
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.title, "Directory listing exposed");
});

test("fingerprintServiceFromBanner identifies common plaintext services", () => {
  assert.equal(fingerprintServiceFromBanner("SSH-2.0-OpenSSH_9.6", 22)?.service, "SSH");
  assert.equal(fingerprintServiceFromBanner("220 smtp.example ESMTP Postfix", 25)?.service, "SMTP");
  assert.equal(fingerprintServiceFromBanner(null, 23)?.service, "Telnet");
});

test("extractServiceExposureFindings flags plaintext services", () => {
  const findings = extractServiceExposureFindings({
    host: "example.com",
    port: 23,
    banner: "Welcome to telnet",
    tool: "banner-grab",
  });

  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.title, "Service identified: Telnet");
  assert.equal(findings[1]?.title, "Telnet service exposed on plaintext port");
  assert.equal(findings[1]?.severity, "high");
});
