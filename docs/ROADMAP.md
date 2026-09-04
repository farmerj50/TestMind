# TestMind AI — Unified Autonomous Engineering Plan

QA, security, self-healing, URL Builder, API testing, and Operator are no longer separate roadmaps. They converge into one TestMind master roadmap whose end state is:

> Give TestMind an application and an objective. TestMind understands the system, determines what needs to be tested, executes the work, investigates failures, validates defects and security findings, repairs its own automation, creates permanent regression protection, measures remaining risk, and decides when enough testing has been completed.

## North-star product

The primary TestMind experience eventually should not be:

- Generate Tests
- Run Security Scan
- Run API Test
- Run URL Builder
- Self Heal

Those remain available as expert tools.

The primary experience becomes:

```
OBJECTIVE

Assess this release.
```

or:

```
Determine whether checkout is ready for production.
```

or:

```
Continuously protect this application.
```

TestMind handles the rest.

## Target architecture

```
                         TESTMIND AI
                             │
                        USER OBJECTIVE
                             │
                             ▼
                ┌────────────────────────┐
                │   APPLICATION BRAIN    │
                │                        │
                │ pages                  │
                │ workflows              │
                │ APIs                   │
                │ identities             │
                │ roles                  │
                │ resources              │
                │ dependencies           │
                │ data                   │
                │ historical defects     │
                │ security boundaries    │
                │ coverage               │
                │ application changes    │
                └───────────┬────────────┘
                            │
                            ▼
                ┌────────────────────────┐
                │ AUTONOMOUS PLANNER     │
                │                        │
                │ What must I test?      │
                │ Why?                   │
                │ In what order?         │
                │ How much effort?       │
                └───────────┬────────────┘
                            │
                            ▼
                ┌────────────────────────┐
                │       OPERATOR         │
                │                        │
                │ Executes the plan      │
                └───────────┬────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
       ▼                    ▼                    ▼
   DISCOVERY               QA                SECURITY
       │                    │                    │
 URL Builder           Playwright          Live Security
 Browser discovery     Functional          OWASP
 API discovery         Integration         Nuclei
 Application map       Negative            Auth/AuthZ
                       Boundary            API Security
                       Accessibility       Business Logic
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                            ▼
                      OBSERVATION
                            │
                            ▼
                ┌────────────────────────┐
                │      INVESTIGATOR      │
                │                        │
                │ What actually failed? │
                └───────────┬────────────┘
                            │
             ┌──────────────┼───────────────┐
             ▼              ▼               ▼
         PRODUCT         AUTOMATION       SECURITY
          DEFECT           DRIFT          HYPOTHESIS
             │              │               │
             │          SELF-HEAL        VALIDATE
             │              │               │
             └──────────────┼───────────────┘
                            ▼
                          VERIFY
                            │
                            ▼
                    REGRESSION PROTECTION
                            │
                            ▼
                     UPDATE KNOWLEDGE
                            │
                            ▼
                ┌────────────────────────┐
                │   COVERAGE + RISK      │
                │                        │
                │ What is still unknown?│
                │ Is more testing useful│
                └───────────┬────────────┘
                            │
                     CONTINUE / STOP
                            │
                            └───────────────↺
```

That is the entire product. Everything already built fits somewhere inside it.

## PHASE 0 — Stabilize the execution foundation

This comes first because the autonomous system cannot be autonomous if a large scan can exhaust Node's heap.

Do not reduce TestMind's discovery power. Change how the system handles volume.

### Build

```
Capture
   ↓
Persist
   ↓
Extract metadata
   ↓
Queue work by ID
   ↓
Load when required
   ↓
Execute
   ↓
Persist evidence
   ↓
Evict
```

Specifically:

- Persist live security exchanges.
- Persist experiment state.
- Persist validation evidence.
- Move active-security scheduling from React to backend workers.
- Keep only a bounded hot exchange cache.
- Store large request/response bodies separately.
- Implement queue backpressure.
- Add memory-pressure throttling.
- Preserve pause/resume across browser reloads.
- Keep rate limiting/adaptive throttling.
- Keep existing scope and authorization controls.

### Success criteria

TestMind should be able to capture something like:

```
50,000 requests
```

without requiring 50,000 full request objects to remain in Node memory.

Closing the browser should not stop the engineer.

## PHASE 1 — Build the Application Brain

This is the most important autonomy milestone.

The existing `applicationModel` becomes the seed. Today it mainly understands things such as pages/forms. Expand it into shared TestMind knowledge.

### Application Brain v2

TestMind should understand:

```
Application
│
├── Pages
├── Components
├── Forms
├── Workflows
├── APIs
├── Services
├── Identities
├── Roles
├── Resources
├── Ownership relationships
├── State transitions
├── Data classifications
├── Dependencies
├── Trust boundaries
├── Historical defects
├── Security findings
├── Test coverage
└── Application changes
```

Example:

```
CHECKOUT WORKFLOW

Risk:
CRITICAL

Pages:
 /cart
 /checkout
 /confirmation

APIs:
 POST /cart
 POST /orders
 POST /payments
 GET /orders/:id

Actor:
 authenticated customer

Resources:
 cart
 account
 order
 payment

State changes:
 creates order
 charges payment

Security boundaries:
 account ownership
 order ownership

Dependencies:
 payment provider

Coverage:
 functional      92%
 API             81%
 negative        69%
 recovery        43%
 authorization   62%
 security        77%
```

Now QA and security are looking at the same application.

### Important rule

Do not build separate:

- QA application model
- Security application model
- API application model

Build one knowledge model. Every specialist contributes to it.

## PHASE 2 — Build the Autonomous Planner

Once TestMind understands the application, it needs to decide what to do.

Create a central `AutonomousPlanner`.

**Inputs:**

- objective
- application knowledge
- changes
- existing tests
- coverage
- risk
- historical failures
- security findings
- available identities
- execution budget
- available tools

**Outputs:**

prioritized engineering tasks

For example:

```
OBJECTIVE:
Assess release 2.4.0

APPLICATION CHANGE:
Checkout modified.

PLANNER:

98  Functional checkout validation
96  POST /orders API validation
95  Payment failure recovery
94  Order authorization validation
88  Checkout accessibility regression
82  Duplicate submission/idempotency
37  Marketing-page visual regression
```

TestMind no longer executes every possible test equally. It asks: *What work gives me the greatest reduction in release risk?*

That's where real autonomy starts.

## PHASE 3 — Turn Operator into the universal execution engine

The Operator spine already exists: `OperatorJob`, `OperatorTask`, `OperatorStep`, `OperatorArtifact`, `OperatorDecision`, `OperatorApproval`. Keep that architecture, but simplify the conceptual responsibility:

**Planner decides what. Operator figures out how.**

Example:

```
Planner:

Validate checkout authorization.

Operator might determine:

Need browser login
→ use Identity A

Need target resource
→ observe GET /orders/:id

Need second identity
→ load Identity B

Need authorization experiment
→ invoke Security Engine

Need proof
→ invoke Validation Engine

Need result stored
→ create evidence
```

The Planner shouldn't know Playwright implementation details. The Operator shouldn't determine business priorities. Clear responsibilities.

## PHASE 4 — Make every current TestMind feature a specialist

Existing features become capabilities the agent can select.

### Discovery specialist

Uses: URL Builder, browser exploration, route discovery, form discovery, API discovery, application-model updates.

Purpose: Understand what exists.

### QA specialist

Uses: Playwright generation, functional testing, integration testing, negative testing, boundary testing, accessibility, state testing, API testing.

Purpose: Determine whether expected behavior works.

### Security specialist

Uses: live authenticated testing, OWASP testing, IDOR/BOLA, authentication, authorization, JWT, CORS, GraphQL, Nuclei, race testing, business-logic testing, code review, anomaly testing.

Purpose: Determine whether behavior can be abused.

Security is therefore one specialist, not the architecture.

### Self-Heal specialist

Uses: deterministic locator repair, live-page verification, LLM fallback, post-repair verification, locator promotion.

Purpose: Repair TestMind's own automation when application structure changes.

### API specialist

Uses: observed traffic, OpenAPI, contracts, boundary behavior, negative scenarios, idempotency, integration behavior.

Purpose: Understand and validate service behavior.

## PHASE 5 — Build the Investigator

This is one of the largest gaps between automated testing and an autonomous engineer.

**A failing test is evidence, not a verdict.**

```
Failure
   ↓
Collect evidence
   ↓
Compare expected/observed behavior
   ↓
Classify
```

Possible results:

- PRODUCT_DEFECT
- AUTOMATION_DRIFT
- ENVIRONMENT_FAILURE
- DATA_FAILURE
- DEPENDENCY_FAILURE
- SECURITY_ANOMALY
- EXPECTED_CHANGE
- UNKNOWN

Then route automatically.

**Example — automation drift:**

```
Checkout test failed.

Investigation:

DOM changed.
API behavior unchanged.
Button text changed.
Equivalent control exists.
No product behavior regression.

Verdict:
AUTOMATION_DRIFT

Action:
Self-heal selector.

Verification:
PASS

Application memory updated.
```

**Example — product defect:**

```
Checkout test failed.

Investigation:

POST /orders returned 500.
UI rendered generic error.
Repeated 3/3.
Independent API call reproduces issue.

Verdict:
PRODUCT DEFECT

Regression test retained.
```

That's autonomous QA reasoning.

## PHASE 6 — Build deterministic security validation

This sits underneath the Security Specialist.

Security tools should emit SIGNAL, not immediately CONFIRMED VULNERABILITY.

The lifecycle:

```
Signal
   ↓
Hypothesis
   ↓
Experiment
   ↓
Evidence
   ↓
Validation
   ↓
Verdict
```

Use statuses such as: confirmed, likely, suspected, inconclusive, not_exploitable, false_positive, not_applicable.

For a CORS example:

```
Scanner:
Potential credentialed CORS.

        ↓

Hypothesis:
Cross-origin authenticated data may be readable.

        ↓

Protocol experiment
Browser experiment
Reproduction attempts

        ↓

CONFIRMED
or
NOT EXPLOITABLE
```

This makes security useful to the autonomous agent instead of drowning it in scanner noise.

## PHASE 7 — Add cross-identity intelligence

Important for both QA and security.

Create first-class identities: Anonymous, Customer A, Customer B, Admin, Manager, etc.

Then resources have ownership relationships:

```
Customer A
    owns
Order 1001

Customer B
    owns
Order 2002
```

TestMind can now reason about:

**Functional behavior** — Can Customer A see their order?

**Security behavior** — Can Customer A see Customer B's order?

Same application knowledge. Different experiment. That's exactly how QA and security start converging into one engineering system.

## PHASE 8 — Build Risk Intelligence

Not every workflow deserves equal testing effort. Create a central Risk Engine.

Factors might include: business criticality, financial state changes, authentication requirement, authorization boundaries, PII/sensitive data, external exposure, change size, historical defect frequency, dependency complexity, current uncertainty, existing coverage.

Example:

```
POST /payment             Risk 99
POST /orders              Risk 96
GET /accounts/:id         Risk 94
POST /password/reset      Risk 93
GET /profile              Risk 68
GET /marketing-content    Risk 12
```

The Autonomous Planner consumes those scores.

## PHASE 9 — Build the Coverage Agent

TestMind needs one entity responsible for answering: **What don't we know?**

Not simply "312 tests passed." Instead:

```
CHECKOUT

Functional         98%
API                94%
Negative           89%
Boundary           83%
Recovery           61%
Accessibility      78%
Authentication    100%
Authorization      92%
Security           88%

Residual risk:
Payment recovery.

Recommendation:
Continue.
```

This Coverage Agent feeds the planner.

## PHASE 10 — Add intelligent stopping and saturation

Testing should not finish merely because `queue.length === 0`. Nor should it continue forever because more mutations are possible.

TestMind should measure information gain.

Example:

```
Overall confidence       94%

Critical workflows      100%
High-risk APIs           98%
Known changes           100%
Auth boundaries          96%
Security critical       94%

Last 25 experiments:
0 significant findings

Last 50:
1 low-value finding

Remaining work:
low-risk

Testing saturation:
96%
```

Then:

> Recommend stopping. Additional testing currently provides minimal reduction in release risk.

That's autonomous judgment.

## PHASE 11 — Close the defect lifecycle

Every confirmed problem should become permanent knowledge.

**Product defect lifecycle**

```
Discover
→ reproduce
→ classify
→ report
→ developer fix
→ verify
→ regression test
→ permanent coverage
```

**Security finding lifecycle**

```
Signal
→ hypothesis
→ validate
→ confirmed finding
→ fix
→ retest
→ close
→ security regression
```

**Automation lifecycle**

```
Failure
→ diagnose drift
→ repair
→ verify
→ update locator knowledge
```

All three ultimately feed: Application Brain.

## PHASE 12 — Continuous application learning

This is what allows TestMind to become more useful over time.

Run 1: 32 routes known, 8 APIs, 2 workflows.

Run 20: 119 routes, 37 APIs, 9 workflows, 6 roles, 22 resources, 14 trust boundaries, 740 regression tests, historic defect patterns, dependency graph, release history.

Then a deployment happens. TestMind shouldn't rediscover the entire application. It should identify: What changed? What might that affect? What existing knowledge is still valid? What new testing is required?

That allows:

```
change
↓
impact analysis
↓
targeted testing
```

instead of permanent full regression.

## PHASE 13 — Move to objective-driven UX

Once the architecture underneath is ready, change the primary UX.

Instead of making the user orchestrate tools (URL Builder → Generate → Run → API → Security → Self Heal → Reports), give them:

```
Objective
Assess current release
```

TestMind displays:

```
UNDERSTANDING

✓ Application model loaded
✓ 7 changed areas discovered
✓ 3 critical workflows affected

PLANNING

✓ 94 regression tests selected
✓ 12 new functional tests required
✓ 9 API experiments required
✓ 6 security experiments required

EXECUTION

81 / 121 complete

INVESTIGATION

3 anomalies investigated
1 product defect
1 selector repaired
1 transient dependency failure

SECURITY

2 candidates
0 confirmed

COVERAGE

Functional      96%
API             94%
Security        91%
Recovery        83%

RELEASE CONFIDENCE

89%

TESTING CONTINUES
```

Later:

```
RELEASE CONFIDENCE

96%

Critical workflows verified.
All high-risk changes assessed.
No confirmed critical security findings.
1 medium non-blocking defect.

RECOMMENDATION:

READY FOR RELEASE
```

That is where TestMind stops looking like a collection of AI features. It looks like an engineer.

## The unified data architecture

Six groups of objects the backend should ultimately center around:

**1. Knowledge** — `Application`, `ApplicationNode`, `ApplicationRelationship`, `Workflow`, `Endpoint`, `Identity`, `Resource`, `Dependency`

**2. Objectives** — `Objective`, `Plan`, `Task`, `Priority`, `Risk`, `Budget`

**3. Execution** — the existing Operator types largely fit here: `OperatorJob`, `OperatorTask`, `OperatorStep`, `OperatorArtifact`, `OperatorDecision`, `OperatorApproval`

**4. Evidence** — `Observation`, `HttpExchange`, `TestResult`, `SecurityExperiment`, `SecurityEvidence`, `Screenshot`, `Trace`, `Diff`

**5. Conclusions** — `ProductDefect`, `SecurityFinding`, `AutomationDrift`, `EnvironmentIssue`

**6. Intelligence** — `Coverage`, `Confidence`, `Risk`, `Saturation`, `ApplicationChange`, `HistoricalOutcome`

That gives one system rather than six disconnected products.

## The agent loop should always remain this simple

Regardless of how complex TestMind becomes internally:

```
UNDERSTAND
     ↓
PLAN
     ↓
ACT
     ↓
OBSERVE
     ↓
INVESTIGATE
     ↓
VERIFY
     ↓
LEARN
     ↓
DECIDE
     ↓
CONTINUE / STOP
```

Every feature added should fit somewhere in that loop. If it doesn't, question whether TestMind actually needs it.

## Development order

| Order | Build | Why |
|---|---|---|
| 1 | Persistent/bounded execution | Prevent crashes and make autonomous jobs durable |
| 2 | Application Brain v2 | Give every capability shared knowledge |
| 3 | Autonomous Planner | Decide what needs doing |
| 4 | Operator extraction | Provide one execution substrate |
| 5 | Investigator | Turn failures into diagnoses |
| 6 | Security Validation Engine | Turn signals into evidence-backed conclusions |
| 7 | Identity/resource graph | Enable real authorization reasoning |
| 8 | Risk Engine | Prioritize intelligently |
| 9 | Coverage Agent | Understand remaining unknowns |
| 10 | Saturation Engine | Know when to stop |
| 11 | Finding → regression lifecycle | Make discoveries permanent |
| 12 | Continuous learning/change impact | Stop rediscovering known systems |
| 13 | Objective-driven UI | Surface the fully autonomous experience |

Do not change that sequence much.

## What not to spend time on right now

Until this core loop is working, avoid major work on:

- another security scanner
- another test generator
- device-farm infrastructure
- more dashboards
- dozens of new integrations
- additional standalone agents
- major cosmetic redesigns
- a huge plugin marketplace

There is already a surprisingly large execution toolbox. The next competitive advantage comes from teaching TestMind when and why to use those tools.

## The milestone that tells us TestMind has crossed the line

This should become the internal autonomy benchmark.

Take an application TestMind has never seen. Give it: URL, credentials, authorized scope, repository if available. Then tell it only:

> Assess this application for release readiness.

Success means TestMind can independently:

1. Discover the application.
2. Build its application model.
3. Identify critical workflows.
4. Discover relevant APIs.
5. Understand identities/resources.
6. Determine risk.
7. Examine existing coverage.
8. Generate missing QA coverage.
9. Execute functional/API tests.
10. Decide which security testing is warranted.
11. Execute controlled security experiments.
12. Investigate failures instead of merely reporting them.
13. Self-heal automation drift.
14. Validate suspected vulnerabilities.
15. Reject false positives.
16. Reproduce real defects.
17. Generate regression protection.
18. Calculate remaining risk.
19. Recognize diminishing returns.
20. Stop itself.
21. Produce a release recommendation backed by evidence.

When TestMind can do that reliably, this is the product.

## The unifying strategy

> Don't build a QA platform with a security scanner attached. Build one autonomous engineering intelligence system that understands an application and has QA, API, security, discovery, self-healing, and investigation as capabilities it can independently deploy.

That is the governing plan for the repository from here.

---

## Governing discipline

Every phase above gets its own closed-scope definition — MUST HAVE / DONE WHEN / NOT INCLUDED — frozen before implementation begins, the same discipline used for Phase 0's execution work. TestMind Autonomous v1 is finished when all six top-level items are done against their own predefined acceptance tests, not when someone decides mid-stream that more subsystems are prerequisites. Anything discovered afterward is v2 work or customer-driven, not evidence that v1 was unfinished.

```
1. Durable execution        [x]  — closed, certified (50,000-exchange volume test passed)
2. Application Brain v1     [x]  — closed, certified (see AB.5's 7-question certification test)
3. Autonomous Planner v1    [x]  — closed, certified (see AP.4's realistic-ceiling certification test)
4. Investigator v1          [x]  — closed, certified (see INV.4's absence-proving certification test)
5. Validation + regression  [x]  — closed, certified (see VR.4's end-to-end + absence-proving certification test)
6. Coverage + stop decision [x]  — closed, certified (see CS.3's end-to-end + absence-proving certification test)
```

**TestMind Autonomous v1 is closed as of CS.3.** All six items passed their own predefined closed-contract acceptance tests, per the governing discipline stated above.

## Program closing statement

Across all six items, TestMind Autonomous v1 delivered one coherent, honest chain: a passively-observed, route-indexed model of what's tested and what's failing (Application Brain v1); a deterministic risk ranking over that model (Autonomous Planner v1); a narrow, evidence-gated failure classifier that declines to guess verdicts it can't support (Investigator v1); a real human-triage state machine for security findings with durable, fully-wired regression-test provenance (Validation + Regression v1, completed end-to-end by Coverage + Stop Decision v1's CS.0 fix); and a read-only, zero-new-persistence coverage view reporting exactly what the rest of the system actually knows — one blended coverage percentage per workflow, real triage-state finding counts, and two raw open-items signals — with no invented percentages and no synthesized stop/continue verdict anywhere (Coverage + Stop Decision v1).

Every item was grounded against the real codebase before a line of implementation code was written, most were independently critiqued by a second Plan-pass before freezing, and every item's contract was narrowed — sometimes drastically — whenever the roadmap's aspirational prose outran what real data/infrastructure could honestly support. Several real, previously-uncaught bugs were found and fixed transparently along the way as part of the item that discovered them (e.g. `Project.updatedAt` not existing during Application Brain v1; workflow `routeHints` never being normalized, found while scoping Autonomous Planner v1; a VR.3B-created regression `TestCase` being completely invisible to Application Brain's coverage rollup, found and fixed while scoping Coverage + Stop Decision v1).

**Explicitly out of scope for v2, named rather than silently dropped:**
- A genuine multi-dimension coverage taxonomy (Functional/API/Negative/Boundary/Recovery/Accessibility/Authentication/Authorization percentages) — would require new classification infrastructure (LLM or deterministic) plus schema to persist it; today's only near-miss (`generate-plan-ai.ts`'s `CoverageMatrix`) is discarded before it ever reaches the database.
- A real findings-over-time trend/saturation engine — would require a `createdAt` index and a fingerprint/dedup field on `SecurityFinding` that don't exist today, plus a defined, non-arbitrary information-gain policy.
- Any automated stop/continue recommendation — requires the trend infrastructure above plus an explicit, product-owned policy for what threshold of open items constitutes "done," which is a business decision, not a grounding question.
- Automated security-finding confirmation (signal → hypothesis → experiment → verdict) for the 15 scanner modules — the sophisticated multi-signal confirmation logic already built for the manual Live Security Test tool (`security/live-security-tests.ts`) was never extended to the automated scan pipeline.
- Real evidence collection for Investigator (live DOM diffing, independent API reproduction) — `PRODUCT_DEFECT`, `DATA_FAILURE`, `DEPENDENCY_FAILURE`, `SECURITY_ANOMALY`, and `EXPECTED_CHANGE` remain unreachable verdicts pending this infrastructure.
- Any `apps/web` UI surface for any of the six items — every item is backend-only, read-only where possible, with real tests as the only verification performed.

Implementation history and the detailed ticket breakdowns for all six items live in the session planning record, not duplicated here — this document is the standing strategic reference.
