import { useEffect, useState } from "react";
const sections = [
  {
    id: "dashboard",
    title: "Dashboard",
    summary:
      "The living overview of your workspace. Dashboard cards surface recent runs, summary stats, and quick links.",
    highlights: [
      "Peek at recent runs and stability trends without leaving the home view.",
      "Click a run card to jump directly into that run's details or its Allure artifacts.",
      "Use the quick filters (status, range, project) to surface the data you care about.",
    ],
    steps: [
      "Set the time range dropdown (top-right) to change the scope of the charts instantly.",
      "Toggle any of the checkboxes (show health, timeline, run feed) to customize the card layout.",
      "Hit the run tile to open the full Run page for details or self-heal options.",
    ],
  },
  {
    id: "reports",
    title: "Reports",
    summary:
      "Quality insights lives here. It surfaces aggregated run metrics, failure reasons, and links into Allure and suites.",
    highlights: [
      "Runs are pulled via `/runner/test-runs` and scoped to your Clerk user projects.",
      "Failure reasons auto-aggregate the parsed error message or summary block.",
      "Download CSV snapshots or click 'View Allure' next to a failed run so you can open the generated report served from `/runner-logs/<id>`.",
    ],
    steps: [
      "Use the left-side filters to limit to specific projects or time ranges before you export.",
      "Click 'View Allure' next to a failed run to open the generated report served from `/runner-logs/<id>`.",
      "If you prefer code editing, use 'Edit in suites' to jump into the suite editor for that run's project.",
    ],
  },
  {
    id: "projects",
    title: "Projects",
    summary:
      "Define each codebase + repo pairing you want to test. Projects own runs, secrets, and suites.",
    highlights: [
      "Create a project with a name, optional repo URL, or use the local repo when running locally.",
      "Store repo-specific secrets once and inject them into runners via `project secrets`.",
      "Delete a project to wipe all runs, suites, secrets, and agent data tied to it.",
    ],
    steps: [
      "Click 'New Project' and give it a repo; you can always reconfigure the repo URL later.",
      "Save recurring secrets (API keys, environment tokens) under the secrets tab so runs can decrypt them.",
      "When a project no longer matters, delete via the overflow menu and confirm to clean everything.",
    ],
  },
  {
    id: "scan",
    title: "Scan & coverage",
    summary:
      "Agent scan and security scan pages let AI explore your base URL, capture flows, and surface findings before running QA.",
    highlights: [
      "Use the AI Page Scanner to start a crawl, drop in mission instructions, and capture page-level coverage plus scenario suggestions.",
      "Security scan scopes allowed hosts/ports/duration and surfaces the latest findings for each target URL.",
      "Every scan records coverage totals and page details so you can rerun or attach the results to projects.",
    ],
    steps: [
      "Pick a project, set the base URL, optionally add instructions, and submit the scanner form.",
      "Review each captured page's summary, coverage bars, and scenario cards before accepting them.",
      "Tune allowed hosts/ports in the security scan card, start a job, and read each finding's explanation/test hints.",
    ],
  },
  {
    id: "security-auth",
    title: "Security scan authentication",
    summary:
      "Configure how the security scanner authenticates before running OWASP/API checks. Enterprise mode is for apps you own and can automate; Bug Bounty mode is for external targets where you must log in by hand.",
    highlights: [
      "Enterprise mode offers five authentication methods: a test-only bypass endpoint your app implements, or direct sign-in against Auth0, Firebase Authentication, AWS Cognito, or Clerk test accounts.",
      "The bypass contract: your app exposes POST /testmind/auth/session, gated by NODE_ENV !== production + TESTMIND_AUTH_BYPASS_ENABLED=true + a shared secret header, and returns { role, sessionCookie, expiresAt }. The secret is stored as a project secret — never hardcoded.",
      "Auth0/Firebase/Cognito/Clerk sign in directly against the provider's own API using a stored test-account password (no browser automation) and return a bearer token used for the scan. Clerk's flow is multi-step and the most fragile of the four — verify it against your actual Clerk app before relying on it.",
      "Bug Bounty mode never touches credentials directly: TestMind opens a live, streamed browser so you log in (and complete MFA) yourself; once authenticated, the session is captured automatically (via a success-URL pattern) or manually with a Capture action. The live browser automatically suppresses common automation fingerprints (navigator.webdriver, window.chrome, navigator.plugins, Client Hints API, permissions.query) so bot-detection checks see a real browser.",
      "If the target uses Cloudflare Bot Management or other TLS-level fingerprinting that blocks the embedded browser, use 'Paste cookies from browser' instead: log in through your real Chrome/Firefox, copy the Cookie header from DevTools (Network tab), and paste it directly — no live browser session needed.",
      "Every captured/authenticated session — from either mode — shows up in the 'Captured auth session' picker on the Configure Scan card so the scan's requests run under that identity.",
      "Sessions expire. Once a session's expiry passes, it's automatically marked expired and disappears from the picker; a Re-authenticate button appears next to its status in both modes.",
      "Finished scans that used auth profiles show an Access control coverage table: rows are BOLA/IDOR, role escalation, admin-route, and session-boundary categories; columns are the roles you had sessions for. 'No issues found' means a session existed and nothing broke — not a guarantee every path was exercised.",
    ],
    steps: [
      "Pick a project, then under Authentication Mode choose Enterprise / My Application (apps you control) or Bug Bounty / External Target (apps you don't).",
      "Enterprise: pick a method from the Authentication method dropdown, fill in that method's connection details (shared secret for bypass; domain/client ID/region/Frontend API URL for the providers) and the project secret holding the test account's password, then click Authenticate.",
      "The session status box shows pending → authenticated, or failed with a specific error you can fix and retry.",
      "Bug Bounty: enter the target URL and login URL, confirm you have authorization/scope to test this target, click Start session capture, then Watch live & log in. Alternatively, select 'Paste cookies from browser', paste the raw Cookie header value, and click Import — useful when the target blocks automation at the TLS layer.",
      "Log in (and complete MFA) inside the live view exactly as you would in a normal browser; TestMind detects success or you click Capture once you're in.",
      "In Configure Scan, pick the captured session from the 'Captured auth session' dropdown before starting the scan.",
      "If a session shows expired or failed, click Re-authenticate next to its status, then repeat the authenticate/capture step.",
      "After the scan completes, check the Access control coverage table on the report for a per-role breakdown of BOLA/IDOR, role-escalation, admin-route, and session-boundary results.",
    ],
  },
  {
    id: "security-scanner",
    title: "Security scanner modules",
    summary:
      "The security scanner runs up to 11 parallel phases covering recon, static analysis, dependency auditing, and a full suite of DAST modules that collectively match or exceed the coverage of leading enterprise DAST tools for API and SPA targets.",
    highlights: [
      "GraphQL audit: detects the GraphQL endpoint (7 common paths tried), runs full introspection, checks unauthenticated access to financial operations, tests cross-account BOLA (harvests IDs from account A, probes with account B), tests query batching abuse, and checks sensitive field leakage in responses.",
      "OpenAPI/Swagger spec import: upload a spec URL or paste the JSON in the API Specification card; the scanner then probes every declared endpoint for auth enforcement, IDOR indicators, injection (SQLi/XSS/path-traversal/template), empty-body server errors, and HTTP method tampering. Supports both OpenAPI 3.x and Swagger 2.0.",
      "JWT analyzer: decodes every JWT from auth profiles; tests alg:none downgrade, brute-forces 15 common weak HMAC secrets, checks expiry/issuer/audience claims, and scans payload for sensitive fields (SSN, card numbers, passwords).",
      "IDOR engine: harvests UUIDs, CUIDs, and numeric IDs from account A's responses, then probes 13 common REST paths and 10 URL templates using account B's session. Falls back to predictable numeric ID increment/decrement for single-profile scans.",
      "Race condition testing: fires 15 concurrent requests to each financial endpoint (transfer, payment, withdrawal, redeem, claim, topup) and common GraphQL mutations. Two or more 2xx responses to the same idempotent operation signals a critical race condition.",
      "Business logic testing: probes financial endpoints with negative amounts, large negative values, zero, integer overflow (int64 max), float overflow (1e308), sub-cent decimal precision, string-typed negative numbers, and null — any 2xx response is a finding. Also tests mass assignment (role, isAdmin, balance, kycStatus, spotme, overdraftLimit) and HTTP parameter pollution.",
      "CORS audit: tests 7 attack patterns against discovered API endpoints — origin reflection (any origin accepted), null origin + credentials, wildcard ACAO + credentials, arbitrary subdomain bypass, regex anchor bypass, HTTP origin accepted by HTTPS target, and trusted internal/localhost origin accepted in production.",
      "JavaScript bundle analysis: fetches the SPA's entry HTML, extracts all script tags, downloads up to 10 JS bundles, and runs 5 regex patterns to surface hidden API paths, auth endpoints, and sensitive configuration in minified code.",
      "Subdomain enumeration: queries crt.sh certificate transparency logs (no API key needed) + DNS brute-force with a 300-entry wordlist; HTTP-probes each discovered subdomain and flags admin, internal, staging, database, and secrets subdomains as high severity.",
      "Nuclei integration: if Nuclei is installed, runs community templates matching the scan depth — baseline checks misconfigurations, exposures, and default logins; standard and deep add CVE, injection, and authentication checks from 10,000+ templates.",
      "Compliance report: after every scan, a full OWASP Top 10 2021, OWASP API Top 10 2023, PCI-DSS v4.0, and SOC 2 Type II CC6 compliance report is generated automatically and available as HTML (print-to-PDF ready) or JSON from the scan results view.",
      "Bug bounty report generator: click 'Generate bug bounty report' on any finding to get a HackerOne/BugCrowd-formatted Markdown report with CVSS v3.1 score, vector string, PoC steps tailored to the finding type, and a financial-context impact statement.",
    ],
    steps: [
      "Import an OpenAPI/Swagger spec (optional but strongly recommended): paste the spec URL or JSON into the API Specification card and click Import. The scanner will probe every declared endpoint.",
      "Add one or more auth profiles — at minimum a primary (user) session. For IDOR and BOLA checks, add a second account with different ownership of financial objects.",
      "Select scan depth: Baseline (fast, safe, no active injection), Standard (adds injection probes and JWT analysis), or Deep (full suite including Nuclei CVE templates).",
      "Start the scan. Progress shows the active phase (Reconnaissance → Access control validation → GraphQL audit → OpenAPI scan → JS bundle analysis → JWT·IDOR·Race·Nuclei → Business logic·CORS → Anomaly baseline).",
      "Once complete, review findings by severity. Critical findings (race conditions on financial endpoints, negative amount accepted, origin reflection with credentials) should be triaged immediately.",
      "Click 'Generate bug bounty report' on any finding to produce a submission-ready HackerOne/BugCrowd report.",
      "Click 'Download HTML report' or 'Download JSON' on the compliance row to get a formatted OWASP/PCI-DSS/SOC 2 compliance report.",
      "To improve coverage on the next scan: add a second auth profile for cross-account BOLA checks, import the OpenAPI spec if you haven't already, and increase the scan depth to Deep to enable Nuclei templates.",
    ],
  },
  {
    id: "agent",
    title: "Agent Sessions",
    summary:
      "Sessions stitch crawlers and QA agents into a single view, showing captured pages, statuses, and generated scenarios.",
    highlights: [
      "Page rows show statuses, coverage percentages, errors, and the scenarios the agent generated.",
      "Coverage totals highlight completed vs failed pages so you can tell when another crawl is needed.",
      "Scenarios carry statuses (suggested/accepted/rejected/completed) plus buttons to attach or generate specs.",
    ],
    steps: [
      "Load a session from the sidebar and scan the page table for coverage, scenarios, and errors.",
      "Accept promising scenarios or reject noisy ones with the action buttons beside each card.",
      "Use 'Generate all accepted' or attach individual scenarios to create Playwright specs before re-running.",
    ],
  },
  {
    id: "qa-agent",
    title: "QA Agent",
    summary:
      "Run curated suites with the QA Agent page; it tracks job status, healing, and optional API coverage for each project.",
    highlights: [
      "Pick a project, curated suite, and optional base URL before hitting 'Start QA agent'.",
      "Toggle parallel execution or include API coverage to rehearse the full end-to-end job.",
      "Job cards poll status (queued, running, succeeded, failed) so you can open the linked run when it finishes.",
    ],
    steps: [
      "Select a project and curated suite from the dropdowns (the suite list already filters to curated entries).",
      "Set an optional base URL and toggle parallel/API options if needed.",
      "Launch the job, watch the status, and open the Reports/Allure links once it completes.",
    ],
  },
  {
    id: "recorder",
    title: "Recorder & helpers",
    summary:
      "Recorder hooks into the helper, saves specs per project, and maps generated cases into your suites via recorded paths.",
    highlights: [
      "Choose an existing project or create one from the base URL before saving a spec.",
      "Helper status and the last callback timestamp show whether `recorder-helper` is online and capturing.",
      "Codegen/launch buttons produce commands that map the generated spec path back to the project's recordings folder.",
    ],
    steps: [
      "Assign a project ID or base URL, name the spec, choose the language, then hit Save to persist it under recordings.",
      "Use 'Get recorder command' or 'Launch recorder' to open Playwright codegen; copy the returned path for suite mapping.",
      "After recording, reference the 'projectId:path' entry to update your curated suite or manual mapping.",
    ],
  },
  {
    id: "shared-steps",
    title: "Shared steps & helpers",
    summary:
      "Promote repeated clicks/flows into shared steps. Capture the JSON preview and optionally screenshot it so teammates can map the same selectors into new suites.",
    highlights: [
      "Open any shared step card, click the JSON icon to view the step data, and snap a screenshot of the payload for visual reference.",
      "Shared steps store selectors, retries, and metadata that help the QA agent rerun brittle flows without re-recording.",
      "Map the shared step ID into multiple suites so updates propagate; the helper status page shows when shared step JSON reruns succeed.",
    ],
    steps: [
      "Expand the Shared Steps drawer from the Recorder or Suite view and hit the JSON toggle to reveal the payload (include a screenshot for docs).",
      "Copy the JSON snippet and paste it into your suite definition or helper file, ensuring the `sharedStepId` and selectors match the recorded screenshot.",
      "Save the shared step, switch to the suite mapping view, and verify the helper is assigned to the proper flow so future runs reuse it.",
    ],
  },
  {
    id: "plan-navigation",
    title: "Plan navigation & mapping",
    summary:
      "Use the plan navigation UI to drop generated tests into curated suites and align the visual plan with the mapping metadata.",
    highlights: [
      "Plan navigation shows the test tree plus mapping indicators (coverage graph + arrows) so you always know where new specs land.",
      "Grab a screenshot of the plan overlay to illustrate target suites, run IDs, and mapping hints when sharing with teammates.",
      "Each mapped plan entry links back to the generated spec path, letting you confirm the Playwright file that executed.",
    ],
    steps: [
      "Open a project, go to the Suites tab, and switch to the Plan view (use the navigation breadcrumbs as a visual cue).",
      "Drag the generated scenario card onto the desired suite lane; the plan overlay will highlight allowed targets (capture the visual state if you need to explain it).",
      "Click the mapping badge to review the JSON/plan mapping info, then link that spec path back to the shared step or helper you recorded earlier.",
    ],
  },
  {
    id: "test-builder",
    title: "Test Builder & Suites",
    summary:
      "Write, organize, and edit user flows. Suites aggregate specs per project and let you re-run them from the UI.",
    highlights: [
      "The Test Builder converts natural-language prompts into Playwright spec drafts you can refine.",
      "Suite editor lists specs for each project, letting you open, edit, or delete them.",
      "Manual reruns from suites ping the runner with the same workflow as the Reports page.",
    ],
    steps: [
      "Run the builder, review the generated spec, then merge it into the project suite so the runner can see it.",
      "Use the suite list to reorder specs, rename them, or add custom filters before running.",
      "Press the Run icon to fire that suite; the run appears in Reports once it completes.",
    ],
  },
];

const firstRunSteps = [
  "Create a Project",
  "Add repo URL (or use local)",
  "Add secrets (if needed)",
  "Run scan/record",
  "View report + fix failures",
];

const commonIssues = [
  {
    id: "nav-slug",
    issue: "Navigation assertions failing because the route slug isn’t visible text",
    fix: "Update the suite selector to target accessible labels or a stable data attribute in suite settings; Allure will show the missing text in the failure trace.",
  },
  {
    id: "auth-redirect",
    issue: "Auth redirects (not logged in / Clerk keys missing)",
    fix: "Add Clerk keys or login fixtures to project secrets/run configs so the agent can authenticate before the redirect Allure step.",
  },
  {
    id: "base-url",
    issue: "Base URL mismatch (localhost vs deployed)",
    fix: "Align the project/run base URL with the environment shown in Allure via the project settings or runner env vars before rerunning.",
  },
  {
    id: "selector-brittle",
    issue: "Selector brittleness / dynamic UI",
    fix: "Switch to aria/role/data selectors or add fallback steps in the suite so Allure stops pointing at the flaky element.",
  },
];

const sharedStepJson = `{
  "title": "Log in with Clerk",
  "selectors": [
    {
      "role": "button",
      "name": "Log in"
    }
  ],
  "retries": 2,
  "stepId": "shared-login-123"
}`;

export default function DocumentsPage() {
  const [selected, setSelected] = useState(sections[0].id);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace("#", "");
    if (hash && sections.some((sec) => sec.id === hash)) {
      setSelected(hash);
    }
  }, []);

  const handleNavigate = (id: string) => {
    if (typeof document === "undefined") {
      setSelected(id);
      return;
    }
    const element = document.getElementById(`doc-${id}`);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
    setSelected(id);
  };

  return (
    <div className="p-6 lg:grid lg:grid-cols-[260px_1fr] gap-6">
      <div className="space-y-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Documentation</p>
          <h1 className="text-lg font-semibold text-slate-900">Guided walkthroughs</h1>
          <p className="text-sm text-slate-600">
            Choose a page below to jump straight to the tips for how to use it.
          </p>
        </div>
        <div>
          <label htmlFor="documents-select" className="text-xs font-medium text-slate-500">
            Go to section
          </label>
          <select
            id="documents-select"
            value={selected}
            onChange={(event) => handleNavigate(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800"
          >
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => handleNavigate(section.id)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                selected === section.id
                  ? "border-blue-500 bg-blue-50 text-blue-800"
                  : "border-slate-200 bg-white text-slate-800 hover:border-slate-300"
              }`}
            >
              {section.title}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-6">
        <FirstRunChecklist />
        <CommonIssues />
        <SharedStepVisual />
        <div className="space-y-8">
          {sections.map((section) => (
            <section
              key={section.id}
              id={`doc-${section.id}`}
              className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">{section.id}</p>
                <h2 className="text-xl font-semibold text-slate-900">{section.title}</h2>
                <p className="text-sm text-slate-600">{section.summary}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Highlights</p>
                  <ul className="mt-2 space-y-2 text-sm text-slate-700">
                    {section.highlights.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-slate-400" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Getting started</p>
                  <ol className="mt-2 space-y-2 text-sm text-slate-700">
                    {section.steps.map((step) => (
                      <li key={step} className="flex items-start gap-2">
                        <span className="font-mono text-xs text-slate-400">-&gt;</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function FirstRunChecklist() {
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">First run</p>
        <h2 className="text-xl font-semibold text-slate-900">Checklist</h2>
        <p className="text-sm text-slate-600">
          This is the #1 thing new users look for—work through it before jumping into Allure.
        </p>
      </div>
      <ol className="space-y-3 text-sm text-slate-700">
        {firstRunSteps.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CommonIssues() {
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">Common issues</p>
        <h2 className="text-xl font-semibold text-slate-900">Allure findings</h2>
        <p className="text-sm text-slate-600">These come up most often when triaging failed runs.</p>
      </div>
      <ul className="space-y-2 text-sm text-slate-700">
        {commonIssues.map((item) => (
          <li key={item.id} className="space-y-1 rounded-lg border border-slate-100 bg-slate-50 p-3">
            <p className="font-semibold text-slate-900">{item.issue}</p>
            <p className="text-xs text-slate-500">{item.fix}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SharedStepVisual() {
  return (
    <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">Shared step visual</p>
        <h2 className="text-xl font-semibold text-slate-900">What the JSON preview should look like</h2>
        <p className="text-sm text-slate-600">
          Capture this screen + the JSON payload so teammates can map selectors/step IDs into other suites or helpers.
        </p>
      </div>
      <pre className="rounded-md border bg-slate-950 p-3 text-xs text-slate-100">{sharedStepJson}</pre>
      <p className="text-xs text-slate-500">
        Screenshot the shared step drawer (highlighting the JSON icon, selectors, and retry metadata) whenever you document a helper.
      </p>
    </section>
  );
}
