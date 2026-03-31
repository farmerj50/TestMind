import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../components/ui/button";
import { Mail, Phone, Calendar, MessageSquare } from "lucide-react";

export default function ContactPage() {
  return (
    <div className="min-h-screen px-6 py-12 lg:px-12">
      <div className="max-w-5xl mx-auto grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="shadow-sm bg-white border border-slate-200">
          <CardHeader>
            <CardTitle className="text-2xl text-slate-900">Book a demo</CardTitle>
            <p className="text-sm text-slate-700">
              Tell us about your team and goals. We’ll get back within one business day.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Name</label>
                <Input placeholder="Alex Smith" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Work email</label>
                <Input type="email" placeholder="alex@company.com" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Company</label>
                <Input placeholder="Acme Corp" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Team size</label>
                <Input placeholder="e.g., 10 engineers" />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-600">What are you looking to achieve?</label>
              <Textarea rows={4} placeholder="Share your goals, current tooling, and timelines." />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-600">Anything else?</label>
              <Textarea rows={3} placeholder="Links to specs, repos, or recent incidents." />
            </div>
            <div className="flex justify-end">
              <Button className="px-6">Submit</Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="shadow-sm bg-white border border-slate-200">
            <CardHeader>
              <CardTitle className="text-lg text-slate-900">Ways to reach us</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-800">
              <div className="flex items-center gap-3">
                <Mail className="h-4 w-4 text-slate-500" />
                <span>sales@testmind.ai</span>
              </div>
              <div className="flex items-center gap-3">
                <Phone className="h-4 w-4 text-slate-500" />
                <span>+1 (555) 123-4567</span>
              </div>
              <div className="flex items-center gap-3">
                <Calendar className="h-4 w-4 text-slate-500" />
                <span>We respond within one business day.</span>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm bg-white border border-slate-200">
            <CardHeader>
              <CardTitle className="text-lg text-slate-900">What to expect</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-800">
              {[
                "A 30-minute walkthrough tailored to your stack.",
                "A live look at AI generation and self-heal flows.",
                "A plan recommendation based on your run volume and team size.",
                "Follow-up with a short summary and next steps.",
              ].map((item) => (
                <div key={item} className="flex items-start gap-2">
                  <MessageSquare className="h-4 w-4 mt-0.5 text-slate-500" />
                  <span>{item}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
