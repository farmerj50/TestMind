// Updated pattern generator using full scan data

import { faker } from "@faker-js/faker";
import { RouteScan } from "./scanner";

export type Step =
  | { kind: "goto"; url: string }
  | { kind: "expect-text"; text: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "upload"; selector: string; path: string };

export type TestCase = {
  id: string;
  name: string;
  group?: { page?: string };
  steps: Step[];
};

const guessValue = (name: string, type: string): string => {
  const n = name.toLowerCase();
  if (n.includes("email")) return faker.internet.email();
  if (n.includes("pass")) return "P@ssw0rd1!";
  if (n.includes("phone")) return faker.string.numeric(10);
  if (n.includes("zip")) return faker.location.zipCode();
  if (type === "number") return "42";
  return faker.lorem.words(2);
};

// Robust URL->pathname that tolerates relative links and missing base
function safePathname(u: string, base?: string): string {
  try {
    return base ? new URL(u, base).pathname : new URL(u).pathname;
  } catch {
    if (typeof u === "string" && u.startsWith("/")) return u;
    return "/";
  }
}

export function patternsFor(scan: RouteScan): TestCase[] {
  const page = safePathname(scan.url);
  const out: TestCase[] = [];

  // Smoke test
  out.push({
    id: `smoke:${scan.url}`,
    name: `Page loads: ${page}`,
    group: { page },
    steps: [
      { kind: "goto", url: scan.url },
      { kind: "expect-text", text: scan.title || "Sign" },
    ],
  });

  // Happy path form test
  if (scan.fields.length) {
    const fillSteps = scan.fields.map((f) => ({
      kind: "fill" as const,
      selector: `[name='${f.name}'], #${f.name}`,
      value: guessValue(f.name, f.type),
    }));

    const clickSteps: Step[] = scan.buttons.length
      ? [{ kind: "click", selector: "button[type='submit'], input[type='submit']" }]
      : [];

    out.push({
      id: `form-happy:${scan.url}`,
      name: `Form submits correctly – ${page}`,
      group: { page },
      steps: [
        { kind: "goto", url: scan.url },
        ...fillSteps,
        ...clickSteps,
        { kind: "expect-text", text: "success" },
      ],
    });
  }

  // Required field validation test
  const requiredFields = scan.fields.filter((f) => f.required);
  if (requiredFields.length && scan.buttons.length) {
    out.push({
      id: `form-validation:${scan.url}`,
      name: `Validation blocks empty submission – ${page}`,
      group: { page },
      steps: [
        { kind: "goto", url: scan.url },
        { kind: "click", selector: "button[type='submit'], input[type='submit']" },
        { kind: "expect-text", text: "required" },
      ],
    });
  }

  // File upload test
  if (scan.fileInputs.length) {
    out.push({
      id: `file-upload:${scan.url}`,
      name: `Upload document – ${page}`,
      group: { page },
      steps: [
        { kind: "goto", url: scan.url },
        {
          kind: "upload",
          selector: `[name='${scan.fileInputs[0]}']`,
          path: "tests/assets/sample.pdf",
        },
        { kind: "click", selector: "button[type='submit'], input[type='submit']" },
        { kind: "expect-text", text: "uploaded" },
      ],
    });
  }

  // Link traversal tests (safe handling for relative links)
  scan.links.slice(0, 3).forEach((link) => {
    const linkPath = safePathname(link, scan.url);
    out.push({
      id: `nav:${scan.url}->${link}`,
      name: `Navigate from ${page} to ${linkPath}`,
      group: { page },
      steps: [
        { kind: "goto", url: scan.url },
        { kind: "goto", url: link },
        { kind: "expect-text", text: linkPath.split("/").pop() || "Page" },
      ],
    });
  });

  return out;
}
