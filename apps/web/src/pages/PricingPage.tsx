import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Check } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { useApi } from "../lib/api";

export default function PricingPage() {
  const tiers: Array<{
    key: "free" | "starter" | "pro" | "team";
    name: string;
    price: string;
    blurb: string;
    features: string[];
    cta: string;
    tag?: string;
    highlighted?: boolean;
  }> = [
    {
      key: "free",
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
    },
    {
      key: "starter",
      name: "Starter / Solo",
      price: "$39",
      blurb: "For individual testers or devs",
      features: [
        "300 runs/month",
        "3 projects",
        "Basic scans",
        "No self-heal",
      ],
      cta: "Start Solo",
    },
    {
      key: "pro",
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
      ],
      cta: "Start Pro",
    },
    {
      key: "team",
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
      ],
      cta: "Start Team",
    },
  ];

  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { apiFetch } = useApi();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const planOrder = useMemo(
    () => ({ free: 0, starter: 1, pro: 2, team: 3 }),
    []
  );
  const currentPlanKey = plan ?? null;
  const currentPlanRank =
    currentPlanKey && currentPlanKey in planOrder
      ? planOrder[currentPlanKey as keyof typeof planOrder]
      : -1;

  const checkoutStatus = useMemo(() => params.get("checkout"), [params]);
  const checkoutSessionId = useMemo(() => params.get("session_id"), [params]);

  useEffect(() => {
    if (!isSignedIn) return;
    apiFetch<{ plan: string | null }>("/billing/me")
      .then((data) => setPlan(data.plan))
      .catch(() => {});
  }, [isSignedIn, apiFetch]);

  useEffect(() => {
    if (!isSignedIn || !checkoutStatus) return;

    if (checkoutStatus === "cancel") {
      setError("Checkout canceled. Pick a plan to continue.");
      return;
    }

    if (checkoutStatus === "success" && checkoutSessionId) {
      setBusyPlan("confirm");
      apiFetch("/billing/confirm", {
        method: "POST",
        body: JSON.stringify({ sessionId: checkoutSessionId }),
      })
        .then(async () => {
          await signOut();
          navigate("/signin", { replace: true });
        })
        .catch((err: any) => {
          setError(err?.message || "Failed to confirm checkout.");
        })
        .finally(() => setBusyPlan(null));
    }
  }, [apiFetch, checkoutSessionId, checkoutStatus, isSignedIn, navigate, signOut]);

  async function handleSelectPlan(planKey: "free" | "starter" | "pro" | "team") {
    setError(null);

    if (!isLoaded) return;
    if (!isSignedIn) {
      navigate(`/signup?plan=${planKey}`);
      return;
    }
    if (currentPlanKey === planKey) return;
    if (currentPlanRank >= 0 && planOrder[planKey] <= currentPlanRank) {
      setError("Plan downgrades are not supported yet. Contact support if you need help.");
      return;
    }

    try {
      setBusyPlan(planKey);
      if (planKey === "free") {
        await apiFetch("/billing/select", {
          method: "POST",
          body: JSON.stringify({ plan: "free" }),
        });
        await signOut();
        navigate("/signin", { replace: true });
        return;
      }

      const data = await apiFetch<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan: planKey }),
      });
      window.location.assign(data.url);
    } catch (err: any) {
      setError(err?.message || "Failed to start checkout.");
    } finally {
      setBusyPlan(null);
    }
  }

  return (
    <div className="min-h-screen px-6 py-12 lg:px-12">
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Pricing</h1>
          <p className="mt-2 text-slate-700">
            Pick a plan and start shipping. Upgrade as your team grows.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {tiers.map((tier) => (
            <Card
              key={tier.name}
              className={`relative border ${tier.highlighted ? "shadow-md bg-white" : "shadow-sm bg-white"} border-slate-200 flex flex-col`}
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
              <CardContent className="flex flex-1 flex-col">
                <ul className="space-y-2 text-sm text-slate-900">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-emerald-600" /> {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-6">
                  <Button
                    className="w-full"
                    variant="default"
                    onClick={() => handleSelectPlan(tier.key)}
                    disabled={
                      busyPlan !== null ||
                      (plan && plan === tier.key) ||
                      (currentPlanRank >= 0 && planOrder[tier.key] <= currentPlanRank)
                    }
                  >
                    {plan && plan === tier.key ? "Current plan" : tier.cta}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
