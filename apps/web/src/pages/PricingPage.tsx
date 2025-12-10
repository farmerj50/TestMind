import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Check } from "lucide-react";
import { Link } from "react-router-dom";

export default function PricingPage() {
  const tiers: Array<{
    name: string;
    price: string;
    blurb: string;
    features: string[];
    cta: string;
    to?: string;
    tag?: string;
    highlighted?: boolean;
  }> = [
    {
      name: "Free",
      price: "$0",
      blurb: "For solo devs testing the waters",
      features: [
        "50 runs/month",
        "1 project",
        "AI generation (limited)",
        "No self-heal",
        "No security scanning",
      ],
      cta: "Start free",
      to: "/signup?plan=free",
    },
    {
      name: "Starter / Solo",
      price: "$39",
      blurb: "For individual testers or devs",
      features: [
        "300 runs/month",
        "3 projects",
        "Basic scans",
        "No self-heal",
        "No Slack reports",
      ],
      cta: "Start Solo",
      to: "/signup?plan=starter",
    },
    {
      name: "Pro",
      price: "$99",
      blurb: "For small teams",
      tag: "Popular",
      highlighted: true,
      features: [
        "2,000 runs/month",
        "10 projects",
        "Parallel runs",
        "Security scans",
        "Slack / email alerts",
        "Self-heal suggestions",
        "Test insights dashboard",
      ],
      cta: "Start Pro",
      to: "/signup?plan=pro",
    },
    {
      name: "Team",
      price: "$249",
      blurb: "For engineering teams with CI pipelines",
      features: [
        "10,000 runs/month",
        "Unlimited projects",
        "SAML SSO",
        "Audit logs",
        "Priority support",
        "AI-heal patches",
        "Multi-user access",
        "Multi-tenant",
      ],
      cta: "Contact sales",
      to: "/signup?plan=team",
    },
  ];

  return (
    <div className="min-h-screen px-6 py-12 lg:px-12">
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Pricing</h1>
          <p className="mt-2 text-slate-700">
            Pick a plan and start shipping. Upgrade as your team grows.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {tiers.map((tier) => (
            <Card
              key={tier.name}
              className={`relative border ${tier.highlighted ? "shadow-md bg-white" : "shadow-sm bg-white"} border-slate-200`}
            >
              {tier.tag && (
                <span className="absolute right-3 top-3 rounded-full bg-slate-900 px-2 py-1 text-xs font-semibold text-white">
                  {tier.tag}
                </span>
              )}
              <CardHeader>
                <CardTitle className="text-xl">{tier.name}</CardTitle>
                <div className="mt-1 text-3xl font-extrabold">
                  {tier.price}
                  <span className="text-base font-normal text-slate-500">/mo</span>
                </div>
                <p className="text-sm text-slate-800">{tier.blurb}</p>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-slate-900">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-emerald-600" /> {f}
                    </li>
                  ))}
                </ul>
                {tier.to ? (
                  <Button
                    asChild
                    className="mt-6 w-full"
                    variant={tier.highlighted ? "default" : "outline"}
                  >
                    <Link to={tier.to}>{tier.cta}</Link>
                  </Button>
                ) : (
                  <Button className="mt-6 w-full" variant={tier.highlighted ? "default" : "outline"}>
                    {tier.cta}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
