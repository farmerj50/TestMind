import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allureReportJson, downloadableArtifact, redactKnownSecrets } from "./artifact-service.js";
import { prisma } from "../prisma.js";

// A slice of the real Allure app.js that the credential-shape heuristic used to corrupt.
const ALLURE_APP_JS = 'var e,n,i;return e=t,(n=[{key:"toHtml",value:function(t){var e=this;t="string"==typeof t?[t]:t;var n=this.stack}}]);';

test("report code assets keep their code; only known project secret values are redacted", () => {
  assert.equal(redactKnownSecrets(ALLURE_APP_JS, []), ALLURE_APP_JS, "minified key:/value: code is not a credential");
  assert.equal(redactKnownSecrets(`const a="s3cr3t-value";const key:"toHtml";`, ["s3cr3t-value"]), `const a="[redacted]";const key:"toHtml";`);
  assert.equal(redactKnownSecrets("Authorization: Bearer abc.def", ["Bearer abc.def"]), "Authorization: [redacted]");
  assert.equal(redactKnownSecrets("token abc.def used", ["token abc.def"]), "[redacted] used");
  assert.equal(redactKnownSecrets("abc.def alone", ["token abc.def"]), "[redacted] alone", "the bare value after a token prefix is redacted too");
});

test("Allure report data keeps test names, statuses and failure details, with secrets still redacted", () => {
  const out = allureReportJson({
    name: "Anonymous access to /contacts is denied (lands on /) [qe:31173381cd8b]",
    status: "failed",
    statusMessage: 'Error: {"code":"GENERATED_LOCATOR_MISSING"} while typing s3cr3t-value',
    statusTrace: "at forgot-password.spec.ts:469:5",
    parameters: [{ name: "password", value: "s3cr3t-value" }],
    extra: { password: "hunter2", note: "api_key=abcdef123456" },
    attachments: [{ name: "trace", source: "data:application/zip;base64,UEsDBBQ" }],
    body: "raw response body",
  }, ["s3cr3t-value"]);
  assert.equal(out.name, "Anonymous access to /contacts is denied (lands on /) [qe:31173381cd8b]");
  assert.equal(out.status, "failed");
  assert.equal(out.statusMessage, 'Error: {"code":"GENERATED_LOCATOR_MISSING"} while typing [redacted]');
  assert.equal(out.statusTrace, "at forgot-password.spec.ts:469:5");
  assert.equal(out.parameters[0].value, "[redacted]");
  assert.equal(out.extra.password, "[redacted]", "sensitive keys are redacted");
  assert.equal(out.extra.note, "[redacted]", "credential-shaped text in data is redacted");
  assert.equal(out.attachments[0].source, "[artifact content withheld]", "embedded archives are withheld");
  assert.equal(out.body, "[artifact content withheld]");
});

test("served end to end: allure-report code is byte-identical, allure data is readable, other JSON stays withheld", async (t) => {
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  assert.ok(project, "requires a project row");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tm-allure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "allure-report", "data"), { recursive: true });
  await fs.writeFile(path.join(root, "allure-report", "app.js"), ALLURE_APP_JS);
  await fs.writeFile(path.join(root, "allure-report", "data", "suites.json"), JSON.stringify({ children: [{ name: "Page loads: /login", status: "passed" }] }));
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify({ suites: [{ title: "Page loads: /login" }] }));
  const serve = (rel: string) => downloadableArtifact({ root, candidate: path.join(root, rel), projectId: project!.id, runId: "run-allure-test" });

  assert.equal((await serve("allure-report/app.js")).data.toString(), ALLURE_APP_JS);
  assert.deepEqual(JSON.parse((await serve("allure-report/data/suites.json")).data.toString()), { children: [{ name: "Page loads: /login", status: "passed" }] });
  assert.match((await serve("report.json")).data.toString(), /artifact content withheld/, "Playwright report.json projection is unchanged");
});
