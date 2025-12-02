import React from "react";
import { motion } from "framer-motion";
import { ArrowRight, Check, Github, ShieldCheck, Zap, Wrench, LineChart, GitPullRequest, Bell, Sparkles } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/ui/accordion";
import { Link } from "react-router-dom";
import { useScrollToHash } from "../lib/useScrollToHash";



// ------------------------------------------------------
// TestMind AI – Investor‑ready landing page (single file)
// - Tailwind + shadcn/ui + framer-motion + lucide icons
// - Drop into apps/web/src/pages/LandingPage.tsx (or App.tsx)
// ------------------------------------------------------

export default function LandingPage() {
    useScrollToHash();

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--tm-bg)] text-slate-900">
      <div
        className="pointer-events-none absolute inset-0 -z-1 landing-pulse"
        style={{
          background: `
            radial-gradient(circle at 20% 25%, rgba(255,255,255,0.15), transparent 45%),
            radial-gradient(circle at 75% 30%, rgba(200,220,255,0.12), transparent 50%),
            radial-gradient(circle at 40% 75%, rgba(255,220,160,0.1), transparent 45%),
            var(--tm-bg)`,
          opacity: 0.65,
        }}
      />
      <SiteHeader />
      <Hero />
      <Logos />
      <Features />
      <HowItWorks />
      <ValueProps />
      <Pricing />
      <Testimonials />
      <FAQ />
      <CTA />
      <SiteFooter />
    </div>
  );
}

// Header / Nav
function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-300 bg-[var(--tm-input-bg)]/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-2">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-white">
            <Sparkles className="h-5 w-5" />
          </span>
          <span className="font-semibold">TestMind AI</span>
        </Link>

        <nav className="hidden items-center gap-6 text-sm md:flex">
          <Link to="/#features" className="hover:text-slate-900 text-slate-800">Features</Link>
          <Link to="/#how" className="hover:text-slate-900 text-slate-800">How it works</Link>
          <Link to="/#pricing" className="hover:text-slate-900 text-slate-800">Pricing</Link>
          <Link to="/#faq" className="hover:text-slate-900 text-slate-800">FAQ</Link>
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" className="hidden md:inline-flex">
            <Link to="/signin">Sign in</Link>
          </Button>
          <Button asChild className="group">
            <Link to="/signup">
              Start free
              <ArrowRight className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
// Hero Section
function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-slate-300 bg-[var(--tm-input-bg)]">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-16 sm:px-6 md:grid-cols-2 md:py-20 lg:px-8">
        <div>
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-4xl font-extrabold tracking-tight sm:text-5xl"
          >
            Ship <span className="bg-gradient-to-r from-slate-900 to-slate-600 bg-clip-text text-transparent">reliable tests</span> in minutes, not weeks.
          </motion.h1>
          <p className="mt-5 max-w-xl text-lg text-slate-800">
            TestMind is an autonomous QA agent that generates Playwright tests from stories or PRs, runs them in CI, and
            <span className="font-semibold text-slate-900"> self-heals</span> brittle selectors with AI.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg" className="h-11 px-6">
          <Link to="/signup">Start free</Link>
        </Button>

        <Button asChild size="lg" variant="outline" className="h-11 px-6">
          <a
            href="https://github.com/your-org/your-repo"
            target="_blank"
            rel="noreferrer"
          >
            <Github className="mr-2 h-4 w-4" /> View on GitHub
          </a>
        </Button>
          </div>
          <ul className="mt-6 grid grid-cols-1 gap-2 text-sm text-slate-800 sm:grid-cols-2">
            {[
              "Generate tests from PRs & stories",
              "Auto-run in GitHub Actions",
              "AI self-healing selectors",
              "Slack & email reports",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-600" /> {t}</li>
            ))}
          </ul>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="relative"
        >
          <div className="relative rounded-2xl border border-slate-300 bg-[var(--tm-bg)] p-4 shadow-sm">
            <div className="rounded-lg bg-slate-950 p-3 text-slate-100">
              <div className="mb-3 text-xs text-slate-400">PR #128 • e2e auto-generated</div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-[12px]/5">
{`import { test, expect } from '@playwright/test';

test('checkout flow', async ({ page }) => {
  await page.goto('https://demo.testmind.dev');
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByRole('heading', { name: /Order confirmed/i })).toBeVisible();
});`}
              </pre>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
              <Badge label="PR opened → tests generated" />
              <Badge label="CI run: 12 passed" />
              <Badge label="1 fixed by self-heal" />
            </div>
          </div>
          <div className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-slate-200/60 blur-3xl" />
        </motion.div>
      </div>
    </section>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center justify-center rounded-full border bg-[var(--tm-bg)] px-3 py-1 text-slate-800 shadow-sm">
      {label}
    </div>
  );
}

// Social proof logos
function Logos() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <p className="mb-4 text-center text-xs uppercase tracking-widest text-slate-500">Trusted by builders from</p>
      <div className="grid grid-cols-2 items-center justify-items-center gap-6 opacity-70 sm:grid-cols-4 md:grid-cols-6">
        {['Acme','Globex','Initech','Umbrella','Stark','Wayne'].map((name) => (
          <div key={name} className="text-sm font-semibold text-slate-400">{name}</div>
        ))}
      </div>
    </section>
  );
}

// Feature grid
function Features() {
  const items = [
    { icon: GitPullRequest, title: 'PR-aware generation', desc: 'Turn PR diffs & stories into runnable Playwright tests.' },
    { icon: Wrench, title: 'Self-healing tests', desc: 'AI proposes minimal patches for flaky selectors & waits.' },
    { icon: Zap, title: 'CI-first', desc: 'Runs in GitHub Actions or your CI — no vendor lock-in.' },
    { icon: LineChart, title: 'Stability analytics', desc: 'Track pass rate, flakiness, and MTTR over time.' },
    { icon: ShieldCheck, title: 'Governance-ready', desc: 'Secretless design with cloud secret managers + audit logs.' },
    { icon: Bell, title: 'Proactive alerts', desc: 'Slack & email digests with actionable diffs.' },
  ];
  return (
    <section id="features" className="border-y border-slate-300 bg-[var(--tm-input-bg)] scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <h2 className="text-center text-3xl font-bold sm:text-4xl">Built for speed • Designed for reliability</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-slate-800">
          Everything you need to automate end-to-end testing from day one — without wrestling brittle scripts.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(({ icon: Icon, title, desc }) => (
            <Card key={title} className="shadow-sm bg-[var(--tm-bg)] border border-slate-300">
              <CardHeader className="flex flex-row items-center gap-3 pb-2">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <Icon className="h-5 w-5" />
                </span>
                <CardTitle className="text-base">{title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-800">{desc}</CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

// How it works
function HowItWorks() {
  const steps = [
    { title: 'Connect your repo', desc: 'Install the GitHub app and pick branches to watch.' },
    { title: 'Open a PR or paste a story', desc: 'We parse diffs / specs and generate Playwright tests.' },
    { title: 'Run & self-heal', desc: 'CI executes tests; AI patches flaky selectors with diffs for review.' },
  ];
  return (
    <section id="how" className="bg-[var(--tm-input-bg)] scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid items-start gap-8 md:grid-cols-2">
          <div>
            <h2 className="text-3xl font-bold">From PR → passing tests in minutes</h2>
            <p className="mt-3 max-w-xl text-slate-800">No brittle boilerplate. Use role-based locators, stable attributes, and AI guardrails by default.</p>
            <ul className="mt-6 space-y-4 text-slate-900">
              {steps.map((s, i) => (
                <li key={s.title} className="flex items-start gap-3">
                  <div className="mt-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">{i+1}</div>
                  <div>
                    <div className="font-semibold">{s.title}</div>
                    <div className="text-sm text-slate-800">{s.desc}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <Card className="shadow-sm bg-[var(--tm-bg)] border border-slate-300">
            <CardHeader>
              <CardTitle>CI run summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 text-sm">
                <Metric label="Total tests" value="124" />
                <Metric label="Pass rate (7d)" value="97%" />
                <Metric label="Self-healed" value="8 patches" />
                <Metric label="Avg. run time" value="4m 12s" />
              </div>
          <div className="mt-4 rounded-lg border bg-[var(--tm-bg)] p-3 text-xs text-slate-800">
                <div className="mb-2 font-mono">patch.diff</div>
                <pre className="overflow-auto text-[11px]">
{`--- a/tests/ai/checkout.spec.ts
+++ b/tests/ai/checkout.spec.ts
@@
- await page.click('#buy');
+ await page.getByRole('button', { name: /Add to cart/i }).click();
+ await expect(page.getByRole('button', { name: /Checkout/i })).toBeEnabled();`}
                </pre>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-[var(--tm-bg)] px-3 py-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

// Value props / bullets
function ValueProps() {
  const bullets = [
    'Cuts authoring time by 80%+',
    'Reduces flaky test noise',
    'Works with your CI & repo',
    'Security-first: no raw tokens stored',
  ];
  return (
    <section className="mx-auto max-w-6xl px-4 py-16">
      <div className="rounded-2xl border bg-[var(--tm-bg)] p-6 shadow-sm md:p-10">
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2">
            <h3 className="text-2xl font-bold">Why teams switch to TestMind</h3>
            <p className="mt-2 max-w-xl text-slate-800">Real ROI from day one: less manual scripting, cleaner CI signals, and AI that proposes safe, minimal diffs.</p>
          </div>
          <ul className="space-y-2 text-sm text-slate-900">
            {bullets.map((b) => (
              <li key={b} className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-600" /> {b}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// Pricing
function Pricing() {
  return (
    <section id="pricing" className="border-t border-slate-300 bg-[var(--tm-input-bg)] scroll-mt-24">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <h2 className="text-center text-3xl font-bold">Simple, transparent pricing</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-slate-800">Start free. Upgrade when your team is ready.</p>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          <PriceCard
  name="Free"
  price="$0"
  blurb="For solo devs testing the waters"
  features={["50 runs/month","1 project","Community support"]}
  cta="Start free"
  to="/signup?plan=free"
/>

<PriceCard
  name="Pro"
  price="$29"
  tag="Popular"
  blurb="For small teams shipping fast"
  features={["500 runs/month","5 projects","Slack reports","Self-heal patches"]}
  cta="Start Pro"
  to="/signup?plan=pro"
  highlighted
/>

<PriceCard
  name="Team"
  price="$99"
  blurb="Growing teams and CI scale"
  features={["5k runs/month","Unlimited projects","SAML SSO","Audit logs"]}
  cta="Contact sales"
  to="/signup?plan=team"
/>

        </div>
      </div>
    </section>
  );
}


function PriceCard({
  name, price, blurb, features, cta, highlighted, tag, to,
}: {
  name: string; price: string; blurb: string; features: string[];
  cta: string; highlighted?: boolean; tag?: string; to?: string;
}) {
  return (
    <Card className={`relative bg-[var(--tm-bg)] border border-slate-300 ${highlighted ? 'shadow-md' : 'shadow-sm'}`}>
      {tag && <span className="absolute right-3 top-3 rounded-full bg-slate-900 px-2 py-1 text-xs font-semibold text-white">{tag}</span>}
      <CardHeader>
        <CardTitle className="text-xl">{name}</CardTitle>
        <div className="mt-1 text-3xl font-extrabold">
          {price}<span className="text-base font-normal text-slate-500">/mo</span>
        </div>
        <p className="text-sm text-slate-800">{blurb}</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm text-slate-900">
          {features.map(f => (
            <li key={f} className="flex items-center gap-2">
              <Check className="h-4 w-4 text-emerald-600" /> {f}
            </li>
          ))}
        </ul>

        {to ? (
          <Button asChild className="mt-6 w-full" variant={highlighted ? 'default' : 'outline'}>
            <Link to={to}>{cta}</Link>
          </Button>
        ) : (
          <Button className="mt-6 w-full" variant={highlighted ? 'default' : 'outline'}>
            {cta}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// Testimonials
function Testimonials() {
  const quotes = [
    { name: 'Priya S.', role: 'QA Lead @ Fintech', quote: 'We turned flaky chaos into stable runs. The AI patches are shockingly good.' },
    { name: 'Marc D.', role: 'VP Eng @ SaaS', quote: 'Cut our authoring time by ~70%. PR-to-test automation sold the team instantly.' },
  ];
  return (
    <section className="bg-[var(--tm-input-bg)]">
      <div className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="text-center text-3xl font-bold">Loved by fast‑moving teams</h2>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {quotes.map((q) => (
            <Card key={q.name} className="shadow-sm">
              <CardContent className="pt-6 text-slate-900">
                “{q.quote}”
                <div className="mt-4 text-sm text-slate-500">— {q.name}, {q.role}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

// FAQ
function FAQ() {
  const faqs = [
    { q: 'Do you commit tests to our repo?', a: 'Your choice. Keep tests in TestMind or let our GitHub app commit to a /tests/ai folder via PR.' },
    { q: 'Will you store our secrets?', a: 'No. We reference cloud secret managers; tokens never persist in our DB.' },
    { q: 'Which frameworks do you support?', a: 'Playwright at launch, with Cypress and Selenium support on the roadmap.' },
    { q: 'How does self-heal work?', a: 'On failure, we analyze logs & DOM, propose a minimal diff, and optionally open a patch PR for review.' },
  ];
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-16 scroll-mt-24">
      <h2 className="text-center text-3xl font-bold">Frequently asked questions</h2>
      <Accordion type="single" collapsible className="mt-6">
        {faqs.map((f, i) => (
          <AccordionItem key={i} value={`item-${i}`}>
            <AccordionTrigger className="text-left">{f.q}</AccordionTrigger>
            <AccordionContent className="text-slate-800">{f.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}

// Final CTA
function CTA() {
  return (
    <section className="border-y border-slate-300 bg-[var(--tm-input-bg)]">
      <div className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h3 className="text-3xl font-bold">Ready to slash QA time and ship faster?</h3>
        <p className="mx-auto mt-2 max-w-2xl text-slate-800">
          Get started in minutes. Connect your repo, open a PR, and watch tests appear.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/signup">Start free</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/contact">Book a demo</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
// Footer
function SiteFooter() {
  return (
    <footer className="bg-[var(--tm-input-bg)]">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white"><Sparkles className="h-4 w-4"/></span>
              <span className="font-semibold">TestMind AI</span>
            </div>
            <p className="mt-2 text-sm text-slate-800">Autonomous QA agents for modern teams.</p>
          </div>
          <div className="text-sm text-slate-800">
            <div className="font-semibold text-slate-900">Product</div>
            <ul className="mt-2 space-y-1">
              <li><Link to="#features" className="hover:underline">Features</Link></li>
              <li><Link to="#pricing" className="hover:underline">Pricing</Link></li>
              <li><Link to="#how" className="hover:underline">How it works</Link></li>
            </ul>
          </div>
          <div className="text-sm text-slate-800">
            <div className="font-semibold text-slate-900">Company</div>
            <ul className="mt-2 space-y-1">
              <li><a href="#" className="hover:underline">Docs</a></li>
              <li><a href="#" className="hover:underline">Security</a></li>
              <li><a href="#" className="hover:underline">Contact</a></li>
            </ul>
          </div>
        </div>
        <div className="mt-8 border-t pt-4 text-sm text-slate-500">© {new Date().getFullYear()} TestMind AI. All rights reserved.</div>
      </div>
    </footer>
  );
}
