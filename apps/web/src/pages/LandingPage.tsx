import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import SEOHead from "../components/SEOHead";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  BrainCircuit,
  Check,
  Code2,
  Container,
  DatabaseZap,
  FileText,
  GitBranch,
  Github,
  GitPullRequest,
  Globe2,
  KeyRound,
  Layers3,
  LockKeyhole,
  Play,
  Radar,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/ui/accordion";
import { useScrollToHash } from "../lib/useScrollToHash";

const workflowSteps = [
  { label: "Discover", icon: Search },
  { label: "Generate Tests", icon: Code2 },
  { label: "Execute", icon: Play },
  { label: "Self Heal", icon: Wrench },
  { label: "Security Intelligence", icon: ShieldCheck },
  { label: "Regression Created", icon: GitBranch },
] satisfies Array<{ label: string; icon: LucideIcon }>;

const workflowMetrics = [
  { tests: 0, repairs: 0, findings: 0 },
  { tests: 18, repairs: 0, findings: 0 },
  { tests: 42, repairs: 0, findings: 0 },
  { tests: 42, repairs: 3, findings: 0 },
  { tests: 42, repairs: 3, findings: 6 },
  { tests: 45, repairs: 3, findings: 6 },
] as const;

const autonomousCapabilities = [
  "Discovers applications",
  "Learns workflows",
  "Generates tests",
  "Executes tests",
  "Investigates failures",
  "Repairs tests",
  "Finds security issues",
  "Creates regression tests",
  "Reports results",
  "Continuously improves coverage",
];

const features = [
  {
    title: "AI Discovery",
    description: "Learns pages, APIs, authentication, and workflows before generating coverage.",
    icon: Radar,
  },
  {
    title: "Intelligent Test Generation",
    description: "Generates maintainable Playwright tests automatically from discovered flows.",
    icon: BrainCircuit,
  },
  {
    title: "Security Intelligence",
    description: "OWASP Top 10, API Top 10, behavior analysis, and authorization testing.",
    icon: ShieldCheck,
  },
  {
    title: "Self-Healing",
    description: "Broken locator? TestMind analyzes the failure and proposes a repair.",
    icon: Wrench,
  },
  {
    title: "Root Cause Analysis",
    description: "Not just element not found. See what changed and why the flow broke.",
    icon: AlertTriangle,
  },
  {
    title: "Continuous Regression",
    description: "Every meaningful defect can become a regression test for the next release.",
    icon: RefreshCw,
  },
] satisfies Array<{ title: string; description: string; icon: LucideIcon }>;

const differentiatorFlows = {
  traditional: [
    "Generate tests",
    "Run tests",
    "Fail",
    "Human investigates",
    "Human fixes",
    "Human writes regression",
  ],
  testmind: [
    "Discovers application",
    "Generates tests",
    "Runs tests",
    "Investigates failure",
    "Repairs locator",
    "Runs security validation",
    "Creates regression",
    "Updates CI",
  ],
};

const technologies = [
  { label: "Playwright", icon: Play },
  { label: "GitHub", icon: Github },
  { label: "GitLab", icon: GitBranch },
  { label: "Jenkins", icon: TerminalSquare },
  { label: "Jira", icon: FileText },
  { label: "Azure DevOps", icon: GitPullRequest },
  { label: "Docker", icon: Container },
  { label: "AWS", icon: Server },
  { label: "React", icon: Layers3 },
  { label: "Angular", icon: Layers3 },
  { label: "Vue", icon: Layers3 },
  { label: "Node", icon: DatabaseZap },
  { label: "Java", icon: Code2 },
  { label: ".NET", icon: Code2 },
] satisfies Array<{ label: string; icon: LucideIcon }>;

const screenshotAssets = [
  { title: "Dashboard", src: "/marketing/screenshots/dashboard.png", icon: BarChart3 },
  { title: "Reports", src: "/marketing/screenshots/reports.png", icon: FileText },
  { title: "Locator Library", src: "/marketing/screenshots/locator-library.png", icon: KeyRound },
  { title: "Security", src: "/marketing/screenshots/security.png", icon: ShieldCheck },
  { title: "Generated Playwright", src: "/marketing/screenshots/generated-playwright.png", icon: Code2 },
  { title: "AI Chat", src: "/marketing/screenshots/ai-chat.png", icon: Bot },
  { title: "Operator", src: "/marketing/screenshots/operator.png", icon: Wrench },
  { title: "Jenkins", src: "/marketing/screenshots/jenkins.png", icon: TerminalSquare },
] satisfies Array<{ title: string; src: string; icon: LucideIcon }>;

const comparisonRows = [
  ["AI Discovery", "No", "No", "Partial", "Yes"],
  ["Playwright Generation", "No", "Manual/codegen", "Partial", "Yes"],
  ["Self Healing", "No built-in", "No built-in", "Yes", "Yes"],
  ["Security Intelligence", "No", "No", "Limited", "Yes"],
  ["Bug Bounty Authentication", "No", "No", "No", "Yes"],
  ["Regression Generation", "Manual", "Manual", "Partial", "Yes"],
  ["Root Cause Analysis", "No", "Trace/logs", "Partial", "Yes"],
] as const;

const roiBenefits = [
  "Reduce maintenance",
  "Improve coverage",
  "Find defects earlier",
  "Consolidate multiple workflows",
];

const faqs = [
  {
    q: "What frameworks do you support?",
    a: "Playwright is the launch focus. The platform is designed around real generated test code instead of a locked-in proprietary format.",
  },
  {
    q: "Does it generate Playwright?",
    a: "Yes. TestMind generates Playwright test files, runs them, and keeps run artifacts available for debugging and reporting.",
  },
  {
    q: "Does it support CI/CD?",
    a: "Yes. TestMind supports CI workflows and Jenkins integration, with GitHub-oriented flows for teams that want test execution tied to delivery.",
  },
  {
    q: "How is Security Intelligence different?",
    a: "Traditional scanners look for signatures. TestMind combines application discovery, authenticated sessions, behavior baselines, and regression creation.",
  },
  {
    q: "Can I test authenticated applications?",
    a: "Yes. Enterprise mode supports stored sessions and auth integrations. Bug Bounty mode supports browser login, MFA, and captured sessions.",
  },
  {
    q: "Can it self-heal tests?",
    a: "Yes. On failure, TestMind analyzes logs and selectors, then proposes focused repairs instead of leaving teams with raw Playwright errors.",
  },
];

export default function LandingPage() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!location.search) return;
    const params = new URLSearchParams(location.search);
    if (params.get("github") === "connected") {
      navigate(`/dashboard${location.search}`, { replace: true });
    }
  }, [location.search, navigate]);

  useScrollToHash();

  const softwareApplicationSchema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "TestMind AI",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    url: "https://www.testsmindai.com/",
    description:
      "TestMind AI autonomously discovers applications, generates Playwright tests, self-heals failures, runs API tests, and performs intelligent security scans.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", category: "Free" },
  };

  return (
    <>
      <SEOHead
        title="TestMind AI — Autonomous QA & Test Automation"
        description="TestMind AI autonomously discovers your app, generates Playwright tests, self-heals on failure, and runs security scans — all without manual scripting. Start free."
        canonicalPath="/"
        jsonLd={softwareApplicationSchema}
      />
      <div className="min-h-screen bg-[var(--tm-bg)] text-slate-950">
        <Hero />
        <AutonomousQAEngineer />
        <PainVsOutcome />
        <PlatformFeatures />
      <DemoSection />
      <WhyDifferent />
      <SupportedTechnologies />
      <EnterpriseBugBounty />
      <ExploreDemo />
      <ProductScreenshots />
      <ComparisonTable />
      <WhyTestMind />
      <ROISection />
      <Pricing />
      <FounderCredibility />
      <FAQ />
      <FinalCTA />
      <SiteFooter />
    </div>
    </>
  );
}

function Hero() {
  const { isLoaded, isSignedIn } = useAuth();
  const primaryCta = isLoaded && isSignedIn
    ? { to: "/dashboard", label: "Go to Dashboard" }
    : { to: "/signup", label: "Start Free" };

  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.02fr_0.98fr] lg:px-8 lg:py-18">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800">
            <Sparkles className="h-3.5 w-3.5" />
            Built for small and mid-size engineering teams
          </div>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
            Autonomous Quality Engineering
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-700">
            One platform that discovers your application, generates Playwright tests, validates security, heals failures,
            and creates regression tests automatically.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg" className="h-11 px-6">
              <Link to={primaryCta.to}>{primaryCta.label}</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-11 px-6">
              <a href="#demo">
                <Play className="mr-2 h-4 w-4" />
                Watch 90-Second Demo
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-11 px-6">
              <a href="#explore-demo">Explore Demo</a>
            </Button>
          </div>
          <div className="mt-8 grid max-w-2xl gap-3 text-sm text-slate-700 sm:grid-cols-3">
            <ProofPoint label="Real Playwright output" />
            <ProofPoint label="CI-ready workflows" />
            <ProofPoint label="Security-aware testing" />
          </div>
        </div>

        <div className="relative">
          <AnimatedWorkflow />
        </div>
      </div>
    </section>
  );
}

function AnimatedWorkflow() {
  const [activeStep, setActiveStep] = useState(1);
  const metrics = workflowMetrics[activeStep];

  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveStep((current) => (current + 1) % workflowSteps.length);
    }, 1300);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-950 p-4 shadow-xl">
      <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
        <div>
          <div className="text-sm font-semibold text-white">Autonomous QA Engineer</div>
          <div className="text-xs text-slate-400">Live quality workflow</div>
        </div>
        <div className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
          Running
        </div>
      </div>
      <div className="space-y-2">
        {workflowSteps.map(({ label, icon: Icon }, index) => {
          const isDone = index < activeStep;
          const isActive = index === activeStep;
          return (
            <div key={label}>
              <motion.div
                animate={{
                  opacity: isDone || isActive ? 1 : 0.5,
                  borderColor: isActive ? "rgba(96,165,250,0.85)" : "rgba(148,163,184,0.22)",
                  backgroundColor: isActive ? "rgba(37,99,235,0.16)" : "rgba(255,255,255,0.04)",
                }}
                transition={{ duration: 0.25 }}
                className="flex min-h-12 items-center justify-between rounded-lg border px-3 py-2"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`grid h-8 w-8 place-items-center rounded-md ${
                      isDone
                        ? "bg-emerald-400/15 text-emerald-300"
                        : isActive
                          ? "bg-blue-400/20 text-blue-200"
                          : "bg-white/10 text-slate-400"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-medium text-slate-100">{label}</span>
                </div>
                {isDone ? (
                  <Check className="h-4 w-4 text-emerald-300" />
                ) : isActive ? (
                  <motion.span
                    animate={{ scale: [0.86, 1.12, 0.86], opacity: [0.65, 1, 0.65] }}
                    transition={{ duration: 1, repeat: Infinity }}
                    className="h-2.5 w-2.5 rounded-full bg-blue-300"
                  />
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full bg-slate-700" />
                )}
              </motion.div>
              {index < workflowSteps.length - 1 && (
                <div className="ml-7 flex h-3 items-center">
                  <div className={`h-full w-px ${index < activeStep ? "bg-emerald-400/60" : "bg-white/10"}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
        <MiniMetric value={String(metrics.tests)} label="tests generated" />
        <MiniMetric value={String(metrics.repairs)} label="failures repaired" />
        <MiniMetric value={String(metrics.findings)} label="security findings" />
      </div>
    </div>
  );
}

function ProofPoint({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <Check className="h-4 w-4 text-emerald-600" />
      <span>{label}</span>
    </div>
  );
}

function MiniMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-2">
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="text-[11px] text-slate-400">{label}</div>
    </div>
  );
}

function AutonomousQAEngineer() {
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-[0.88fr_1.12fr]">
          <div>
            <div className="text-sm font-semibold uppercase tracking-wide text-blue-700">
              The Autonomous QA Engineer
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              A quality operator that keeps learning your product
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-700">
              TestMind is not just a recorder. It is an AI workflow that discovers coverage gaps, generates runnable
              Playwright tests, investigates failures, repairs tests, validates security, and reports the result.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {autonomousCapabilities.map((capability, index) => (
              <div
                key={capability}
                className="flex min-h-14 items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-800"
              >
                <span className="grid h-7 w-7 place-items-center rounded-md bg-white text-blue-700 ring-1 ring-slate-200">
                  <Check className="h-4 w-4" />
                </span>
                {capability}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PainVsOutcome() {
  return (
    <section className="bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-2">
          <FlowPanel
            eyebrow="Companies still do this"
            tone="rose"
            steps={[
              "Requirements",
              "Developer writes code",
              "QA writes tests",
              "Security scans later",
              "Bug found",
              "QA updates tests",
              "Repeat",
            ]}
          />
          <FlowPanel
            eyebrow="With TestMind"
            tone="blue"
            steps={[
              "AI discovers application",
              "Generates tests",
              "Runs security validation",
              "Self-heals",
              "Creates regression",
              "Reports everything",
            ]}
          />
        </div>
      </div>
    </section>
  );
}

function FlowPanel({ eyebrow, steps, tone }: { eyebrow: string; steps: string[]; tone: "rose" | "blue" }) {
  const styles =
    tone === "rose"
      ? "border-rose-200 bg-white text-rose-700"
      : "border-blue-200 bg-white text-blue-700";
  return (
    <div className={`rounded-xl border p-5 shadow-sm ${styles}`}>
      <div className="text-sm font-semibold uppercase tracking-wide">{eyebrow}</div>
      <div className="mt-5 grid gap-2">
        {steps.map((step, index) => (
          <div key={step}>
            <div className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-800">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-white text-xs text-slate-600 ring-1 ring-slate-200">
                {index + 1}
              </span>
              {step}
            </div>
            {index < steps.length - 1 && <div className="ml-6 h-3 w-px bg-slate-300" />}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlatformFeatures() {
  return (
    <section id="features" className="bg-white scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Platform features"
          title="Everything a small QA team needs to move faster"
          description="TestMind packages discovery, generation, execution, security checks, and maintenance into one workflow."
        />
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {features.map(({ title, description, icon: Icon }) => (
            <Card key={title} className="border-slate-200 bg-white shadow-sm">
              <CardHeader className="pb-3">
                <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-slate-950 text-white">
                  <Icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-lg">{title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-6 text-slate-700">{description}</CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function DemoSection() {
  const [videoMissing, setVideoMissing] = useState(false);

  return (
    <section id="demo" className="border-y border-slate-200 bg-slate-950 scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid items-center gap-8 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <div className="text-sm font-semibold uppercase tracking-wide text-blue-300">Product demo</div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Watch TestMind in Action
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-300">
              The highest-converting asset for this page is a real 90-second product video: discovery, generated tests,
              execution, failure explanation, self-heal, security validation, and regression creation.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild size="lg" className="bg-white text-slate-950 hover:bg-slate-100">
                <a href="#explore-demo">Explore Demo</a>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10">
                <Link to="/contact">Book a Live Walkthrough</Link>
              </Button>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-rose-400" />
                <span className="h-3 w-3 rounded-full bg-amber-400" />
                <span className="h-3 w-3 rounded-full bg-emerald-400" />
              </div>
              <div className="text-xs text-slate-400">/marketing/testmind-90-second-demo.mp4</div>
            </div>
            <div className="relative grid aspect-video place-items-center overflow-hidden bg-black">
              {!videoMissing && (
                <video
                  className="h-full w-full bg-black object-contain"
                  controls
                  playsInline
                  preload="metadata"
                  poster="/marketing/screenshots/dashboard.png"
                  onError={() => setVideoMissing(true)}
                >
                  <source src="/marketing/testmind-90-second-demo.mp4" type="video/mp4" />
                </video>
              )}
              {videoMissing && (
              <div className="text-center">
                <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/30">
                  <Play className="h-9 w-9 fill-current" />
                </div>
                <div className="mt-5 text-xl font-semibold text-white">Add the real 90-second product demo</div>
                <div className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">
                  Drop the final video at <span className="font-mono text-slate-200">apps/web/public/marketing/testmind-90-second-demo.mp4</span>.
                </div>
                <div className="mt-6 grid gap-2 text-left text-sm text-slate-300 sm:grid-cols-3">
                  <DemoStep label="1. Discover" />
                  <DemoStep label="2. Generate" />
                  <DemoStep label="3. Repair" />
                </div>
              </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DemoStep({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-center">{label}</div>
  );
}

function WhyDifferent() {
  return (
    <section id="security" className="bg-white scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Why TestMind is Different"
          title="The workflow does not stop when a test fails"
          description="Traditional tools still leave investigation, repair, regression creation, and CI updates to people. TestMind turns those steps into one connected quality workflow."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <ComparisonPanel
            title="Traditional tools"
            icon={Search}
            items={differentiatorFlows.traditional}
          />
          <ComparisonPanel
            title="TestMind"
            icon={Bot}
            highlighted
            items={differentiatorFlows.testmind}
          />
        </div>
      </div>
    </section>
  );
}

function ComparisonPanel({
  title,
  icon: Icon,
  items,
  highlighted,
}: {
  title: string;
  icon: LucideIcon;
  items: string[];
  highlighted?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-5 shadow-sm ${highlighted ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50"}`}>
      <div className="flex items-center gap-3">
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${highlighted ? "bg-blue-600 text-white" : "bg-slate-900 text-white"}`}>
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
      </div>
      <div className="mt-5 grid gap-2">
        {items.map((item, index) => (
          <div key={item} className="flex items-center gap-3 rounded-lg border border-white bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
            <span className="text-xs font-semibold text-slate-400">{String(index + 1).padStart(2, "0")}</span>
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function SupportedTechnologies() {
  return (
    <section className="border-y border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Supported technologies"
          title="Fits the stack SMB teams already use"
          description="Start with Playwright and CI, then connect the systems your team already depends on."
        />
        <div className="mt-9 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
          {technologies.map(({ label, icon: Icon }) => (
            <div
              key={label}
              className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-3 text-center shadow-sm"
            >
              <Icon className="h-5 w-5 text-slate-700" />
              <span className="text-sm font-medium text-slate-800">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function EnterpriseBugBounty() {
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Authenticated testing"
          title="Enterprise apps and external targets need different auth flows"
          description="TestMind separates internal application testing from authorized external target workflows."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <ModePanel
            title="Enterprise"
            icon={LockKeyhole}
            items={["Auth integrations", "Stored sessions", "Test bypass", "Continuous scans"]}
          />
          <ModePanel
            title="Bug Bounty"
            icon={Globe2}
            items={["Browser login", "MFA support", "Session capture", "Authenticated scanning"]}
          />
        </div>
      </div>
    </section>
  );
}

function ModePanel({ title, icon: Icon, items }: { title: string; icon: LucideIcon; items: string[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-slate-950 text-white">
          <Icon className="h-5 w-5" />
        </div>
        <h3 className="text-xl font-semibold text-slate-950">{title}</h3>
      </div>
      <ul className="mt-5 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <Check className="h-4 w-4 text-emerald-600" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExploreDemo() {
  const views = [
    {
      name: "Dashboard",
      icon: BarChart3,
      headline: "Release readiness",
      stats: ["97% pass rate", "42 tests generated", "3 repairs proposed"],
      details: ["Smoke suite passed", "Checkout flow covered", "Auth regression updated"],
    },
    {
      name: "Reports",
      icon: FileText,
      headline: "Run intelligence",
      stats: ["38 runs", "6 flaky tests", "12m saved triage"],
      details: ["Failure clustered by root cause", "Trend visible by project", "CI history preserved"],
    },
    {
      name: "Security",
      icon: ShieldCheck,
      headline: "Authenticated scan",
      stats: ["6 findings", "2 auth checks", "1 regression"],
      details: ["Behavior baseline created", "Authorization boundary checked", "Regression generated"],
    },
    {
      name: "Tests",
      icon: Code2,
      headline: "Generated Playwright",
      stats: ["12 specs", "184 locators", "8 workflows"],
      details: ["Role-first locators", "Readable test names", "Reusable login helpers"],
    },
    {
      name: "Operator",
      icon: Wrench,
      headline: "Approval workflow",
      stats: ["2 approvals", "1 deep scan", "0 blocked jobs"],
      details: ["Security scan approved", "Repair queued", "CI update ready"],
    },
  ];
  const [active, setActive] = useState(0);
  const current = views[active];
  const Icon = current.icon;

  return (
    <section id="explore-demo" className="border-y border-slate-200 bg-slate-50 scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Live demo"
          title="Explore a completed project without creating an account"
          description="Use this as the public sample workspace: dashboard, reports, security, tests, locator library, operator, and CI context."
        />
        <div className="mt-10 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex gap-2 overflow-x-auto border-b border-slate-200 p-3">
            {views.map((view, index) => {
              const ViewIcon = view.icon;
              return (
                <button
                  key={view.name}
                  type="button"
                  onClick={() => setActive(index)}
                  className={`flex min-w-fit items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
                    active === index
                      ? "bg-slate-950 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  <ViewIcon className="h-4 w-4" />
                  {view.name}
                </button>
              );
            })}
          </div>
          <div className="grid gap-6 p-5 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-lg bg-blue-600 text-white">
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">{current.name}</div>
                  <div className="text-xl font-semibold text-slate-950">{current.headline}</div>
                </div>
              </div>
              <div className="mt-5 grid gap-2">
                {current.stats.map((stat) => (
                  <div key={stat} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800">
                    {stat}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-950 p-5 text-white">
              <div className="mb-4 flex items-center justify-between">
                <div className="text-sm font-semibold">Sample project: SaaS checkout</div>
                <div className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs text-emerald-300">Completed</div>
              </div>
              <div className="grid gap-3">
                {current.details.map((detail, index) => (
                  <motion.div
                    key={detail}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.04 }}
                    className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-3 text-sm text-slate-200"
                  >
                    <Check className="h-4 w-4 text-emerald-300" />
                    {detail}
                  </motion.div>
                ))}
              </div>
              <div className="mt-5 rounded-lg border border-white/10 bg-black/20 p-3 font-mono text-xs text-slate-300">
                {current.name === "Tests"
                  ? "await expect(page.getByRole('heading', { name: /Checkout/i })).toBeVisible();"
                  : "testmind run completed - artifacts, findings, and regression updates ready"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProductScreenshots() {
  return (
    <section id="screenshots" className="border-y border-slate-200 bg-slate-50 scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Product screenshots"
          title="Show the real product surfaces buyers care about"
          description="Real views of the TestMind workspace across quality health, generation, reporting, security, and CI workflows."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {screenshotAssets.map((asset) => (
            <ScreenshotAssetCard key={asset.title} {...asset} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ScreenshotAssetCard({ title, src, icon: Icon }: { title: string; src: string; icon: LucideIcon }) {
  const [missing, setMissing] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Icon className="h-4 w-4 text-blue-600" />
          {title}
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">Screenshot</span>
      </div>
      <div className="aspect-[16/10] bg-slate-950">
        {!missing ? (
          <img
            src={src}
            alt={`${title} screenshot`}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
            onError={() => setMissing(true)}
          />
        ) : (
          <div className="grid h-full place-items-center p-5 text-center">
            <div>
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-white text-blue-600 ring-1 ring-slate-200">
                <Icon className="h-5 w-5" />
              </div>
              <div className="mt-3 text-sm font-semibold text-slate-800">Add real {title} screenshot</div>
              <div className="mt-1 break-all font-mono text-xs text-slate-500">{src}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ComparisonTable() {
  const columns = ["Feature", "Selenium", "Playwright", "Tricentis", "TestMind"];
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Factual comparison"
          title="Where TestMind fits"
          description="A practical comparison for SMB teams choosing between frameworks, enterprise suites, and an AI QA cockpit. Capabilities vary by edition and implementation."
        />
        <div className="mt-10 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="tm-comparison-table min-w-[820px] w-full border-collapse text-left text-sm">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} className="px-4 py-3 font-semibold">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, index) => (
                    <td
                      key={`${row[0]}-${index}`}
                      className={`px-4 py-3 ${index === 0 || index === 4 ? "font-semibold" : ""}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          Notes: Selenium and Playwright are excellent automation foundations, not full lifecycle QA platforms by
          default. Tricentis has mature enterprise automation and self-healing capabilities; TestMind is positioned for
          Playwright-native SMB teams that want AI discovery, maintenance, and security workflows in one product.
        </p>
      </div>
    </section>
  );
}

function WhyTestMind() {
  const rows = [
    ["Playwright + GitHub Actions", "Great execution foundation, but teams still author, triage, heal, and report manually."],
    ["Traditional enterprise suites", "Powerful, but often heavy for SMB teams that want fast Playwright-native workflows."],
    ["TestMind", "Discovery, Playwright generation, CI execution, failure explanation, self-heal, and security validation in one cockpit."],
  ];
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Why TestMind?"
          title="More than a framework, lighter than an enterprise suite"
          description="An objective middle ground for teams that want practical automation without building a full QA platform themselves."
        />
        <div className="mt-10 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {rows.map(([label, description], index) => (
            <div key={label} className={`grid gap-3 px-5 py-4 md:grid-cols-[240px_1fr] ${index > 0 ? "border-t border-slate-200" : ""}`}>
              <div className="font-semibold text-slate-950">{label}</div>
              <div className="text-sm leading-6 text-slate-700">{description}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ROISection() {
  return (
    <section className="border-y border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="ROI"
          title="Managers buy lower maintenance and earlier signal"
          description="Frame TestMind around the operational work it consolidates: discovery, generation, execution, regression, security, and reporting."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <div className="rounded-xl border border-rose-200 bg-white p-5 shadow-sm">
            <div className="text-sm font-semibold uppercase tracking-wide text-rose-700">Without TestMind</div>
            <div className="mt-5 grid gap-3">
              {["Manual test authoring", "Separate security scans", "Raw CI failures", "Human locator repair", "Regression work after defects"].map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                  <AlertTriangle className="h-4 w-4 text-rose-600" />
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-blue-200 bg-white p-5 shadow-sm">
            <div className="text-sm font-semibold uppercase tracking-wide text-blue-700">With TestMind</div>
            <div className="mt-5 grid gap-3">
              {["Discovery", "Generation", "Execution", "Regression", "Security"].map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                  <Check className="h-4 w-4 text-emerald-600" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {roiBenefits.map((benefit) => (
            <div key={benefit} className="rounded-lg border border-slate-200 bg-white px-4 py-4 text-sm font-semibold text-slate-800 shadow-sm">
              {benefit}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  const tiers = [
    {
      name: "Free",
      price: "$0",
      description: "Explore generation and basic runs.",
      features: ["1 project", "Limited AI generation", "Basic reports"],
      cta: "Start Free",
    },
    {
      name: "Pro",
      price: "$99",
      description: "For small teams running tests in CI.",
      features: ["10 projects", "Security scans", "Self-heal suggestions", "Slack and email alerts"],
      cta: "Start Pro",
      highlighted: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      description: "For teams needing SSO, audit, and advanced security workflows.",
      features: ["SSO", "Audit logs", "Priority support", "Advanced auth workflows"],
      cta: "Contact Sales",
    },
  ];
  return (
    <section id="pricing" className="border-y border-slate-200 bg-slate-50 scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader
          eyebrow="Pricing"
          title="Simple plans for teams that need traction"
          description="Start free, move to Pro when your team needs CI, security scans, and maintenance help."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {tiers.map((tier) => (
            <Card key={tier.name} className={`border-slate-200 bg-white shadow-sm ${tier.highlighted ? "ring-2 ring-blue-500" : ""}`}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{tier.name}</CardTitle>
                  {tier.highlighted && <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">Popular</span>}
                </div>
                <div className="mt-3 text-3xl font-semibold text-slate-950">{tier.price}</div>
                <p className="text-sm leading-6 text-slate-600">{tier.description}</p>
              </CardHeader>
              <CardContent className="flex min-h-[230px] flex-col">
                <ul className="space-y-2 text-sm text-slate-700">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-emerald-600" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-6">
                  {tier.name === "Enterprise" ? (
                    <Button asChild variant="outline" className="w-full">
                      <Link to="/contact">{tier.cta}</Link>
                    </Button>
                  ) : (
                    <Button asChild className="w-full" variant={tier.highlighted ? "default" : "outline"}>
                      <Link to={`/signup?plan=${tier.name.toLowerCase()}`}>{tier.cta}</Link>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function FounderCredibility() {
  const credibility = ["14+ years", "Enterprise QA Automation", "Healthcare", "Finance", "Government", "SaaS"];
  return (
    <section className="bg-white">
      <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 shadow-sm sm:p-8">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-lg bg-slate-950 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-center text-2xl font-semibold text-slate-950">
            Built by a QA Automation Engineer
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-sm leading-6 text-slate-700">
            Built from enterprise testing experience for teams that need practical automation, readable tests, and fewer
            release surprises. Customer testimonials will replace this section after beta users go live.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {credibility.map((item) => (
              <div key={item} className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-center text-sm font-semibold text-slate-800">
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function FAQ() {
  return (
    <section id="faq" className="bg-slate-50 scroll-mt-24">
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <SectionHeader eyebrow="FAQ" title="Questions buyers ask before trying TestMind" />
        <Accordion type="single" collapsible className="mt-8 rounded-xl border border-slate-200 bg-white px-4">
          {faqs.map((faq, index) => (
            <AccordionItem key={faq.q} value={`faq-${index}`}>
              <AccordionTrigger className="text-left">{faq.q}</AccordionTrigger>
              <AccordionContent className="text-sm leading-6 text-slate-700">{faq.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

function FinalCTA() {
  const { isLoaded, isSignedIn } = useAuth();
  const primaryCta = isLoaded && isSignedIn
    ? { to: "/dashboard", label: "Go to Dashboard" }
    : { to: "/signup", label: "Start Free" };

  return (
    <section className="bg-slate-950">
      <div className="mx-auto max-w-5xl px-4 py-14 text-center sm:px-6 lg:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-white">Give your QA workflow an AI operator</h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-300">
          Start with one project, one flow, and one CI run. See whether TestMind saves your team time before expanding.
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="bg-white text-slate-950 hover:bg-slate-100">
            <Link to={primaryCta.to}>{primaryCta.label}</Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10">
            <Link to="/contact">Talk to Us</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  const links = [
    ["Privacy Policy", "/privacy"],
    ["Terms of Service", "/documents"],
    ["Responsible Security Testing Policy", "/documents"],
    ["Contact", "/contact"],
    ["Documentation", "/documents"],
    ["GitHub", "https://github.com/farmerj50/TestMind"],
    ["Status page", "/contact"],
  ];
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-[1.2fr_1fr]">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-slate-950">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-950 text-white">
                <Sparkles className="h-4 w-4" />
              </span>
              TestMind AI
            </div>
            <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
              Autonomous Quality Engineering for teams that want useful Playwright coverage, clearer failures, and less test maintenance.
            </p>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            {links.map(([label, href]) =>
              href.startsWith("http") ? (
                <a key={label} href={href} target="_blank" rel="noreferrer" className="text-slate-600 hover:text-slate-950">
                  {label}
                </a>
              ) : (
                <Link key={label} to={href} className="text-slate-600 hover:text-slate-950">
                  {label}
                </Link>
              )
            )}
          </div>
        </div>
        <div className="mt-8 border-t border-slate-200 pt-4 text-sm text-slate-500">
          (c) {new Date().getFullYear()} TestMind AI. All rights reserved.
        </div>
      </div>
    </footer>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <div className="text-sm font-semibold uppercase tracking-wide text-blue-700">{eyebrow}</div>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{title}</h2>
      {description && <p className="mt-3 text-base leading-7 text-slate-700">{description}</p>}
    </div>
  );
}
