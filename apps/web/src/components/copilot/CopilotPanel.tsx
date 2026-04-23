import { useEffect, useRef, type KeyboardEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Sparkles,
  Wrench,
  Search,
  FileCode2,
  Send,
  X,
  Trash2,
  Shield,
  Play,
  Layers,
} from "lucide-react";
import { useCopilot, type Message, type CopilotStats } from "../../context/CopilotContext";

// ─── Route-aware quick actions ────────────────────────────────────────────────

type QuickAction = { label: string; icon: React.ElementType; prompt: string };

function getQuickActions(route: string, stats: CopilotStats | null): QuickAction[] {
  const failing = stats?.failing ?? 0;
  const hotspot = stats?.hotspot;

  if (route.startsWith("/qa-agent")) {
    return [
      { label: "Explain QA Agent phases", icon: Layers, prompt: "Explain the QA Agent execute → triage → repair → verify lifecycle" },
      { label: "Setup a new QA job", icon: Play, prompt: "Walk me through setting up a QA Agent job for my project" },
      { label: "What happens during triage?", icon: Search, prompt: "What does the triage phase do and what output does it produce?" },
      { label: "Generate a regression suite", icon: FileCode2, prompt: "Generate a regression test suite for my project" },
    ];
  }
  if (route.startsWith("/operator")) {
    return [
      { label: "Explain job types", icon: Layers, prompt: "Explain the difference between QA, Repair, Discovery, and Security operator jobs" },
      { label: "When to use Repair vs QA?", icon: Wrench, prompt: "When should I run a Repair job vs a full QA job?" },
      { label: "Run Discovery job", icon: Search, prompt: "How does a Discovery job work and what does it find?" },
      { label: "Setup a Security scan", icon: Shield, prompt: "How do I set up a Security scan operator job?" },
    ];
  }
  if (route.startsWith("/security-scan")) {
    return [
      { label: "Explain OWASP findings", icon: Shield, prompt: "Explain the OWASP Top 10 findings TestMind can detect" },
      { label: "Generate security test plan", icon: FileCode2, prompt: "Generate a security test plan for my web app" },
      { label: "What is active scanning?", icon: Search, prompt: "What's the difference between passive and active security scanning?" },
      { label: "Fix a critical finding", icon: Wrench, prompt: "How do I remediate a critical security finding found by TestMind?" },
    ];
  }
  if (route.startsWith("/test-builder")) {
    return [
      { label: "Write a login test", icon: FileCode2, prompt: "Generate a Playwright test for a login form with email and password fields" },
      { label: "Write a form validation test", icon: FileCode2, prompt: "Generate a Playwright test that validates required form fields" },
      { label: "How to use Test Builder?", icon: Layers, prompt: "How do I use the Test Builder to create a test without writing code?" },
      { label: "Best practices for selectors", icon: Search, prompt: "What are best practices for choosing Playwright selectors?" },
    ];
  }
  if (route.startsWith("/agent")) {
    return [
      { label: "Start an agent scan", icon: Play, prompt: "How do I start an Agent Scan session for my app?" },
      { label: "Explain coverage types", icon: Layers, prompt: "Explain the coverage types the Agent generates: statement, branch, edge, decision, security" },
      { label: "Accept and attach scenarios", icon: Sparkles, prompt: "How do I accept agent scenarios and attach them to my project?" },
      { label: "Generate test from scenario", icon: FileCode2, prompt: "How do I generate a Playwright spec from an accepted agent scenario?" },
    ];
  }

  // Default / dashboard — use live data
  const actions: QuickAction[] = [];
  if (failing > 0 && hotspot) {
    actions.push({ label: `Fix ${hotspot} failures`, icon: Wrench, prompt: `I have ${failing} failing tests with ${hotspot} as the biggest hotspot. Help me triage and fix them.` });
  }
  actions.push({ label: "Analyze failure patterns", icon: Search, prompt: `Analyze the current failure patterns across my test suite${failing > 0 ? ` (${failing} failing)` : ""}` });
  actions.push({ label: "Generate regression coverage", icon: FileCode2, prompt: "Generate a regression test suite covering the most critical user flows" });
  actions.push({ label: "Create login test", icon: Sparkles, prompt: "Generate a complete Playwright test for a login page with email/password" });
  return actions.slice(0, 4);
}

// ─── Code block renderer ──────────────────────────────────────────────────────

function renderContent(text: string) {
  const parts = text.split(/(```[\w]*\n[\s\S]*?```)/g);
  return parts.map((part, i) => {
    const m = part.match(/^```([\w]*)\n([\s\S]*?)```$/);
    if (m) {
      const [, lang, code] = m;
      return (
        <div key={i} className="my-2">
          {lang && (
            <div className="flex items-center gap-1.5 bg-slate-800 rounded-t-lg px-3 py-1 border-b border-white/10">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wide">{lang}</span>
            </div>
          )}
          <pre className={`bg-[#060e1a] text-slate-100 p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${lang ? "rounded-b-lg" : "rounded-lg"}`}>
            {code}
          </pre>
        </div>
      );
    }
    return (
      <span key={i} className="whitespace-pre-wrap leading-relaxed">
        {part}
      </span>
    );
  });
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isEmpty = message.content === "" && message.isStreaming;

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="bg-gradient-to-br from-violet-500 to-blue-500 text-white rounded-[22px] rounded-tr-sm px-4 py-2.5 text-sm shadow-lg shadow-violet-500/20">
            {message.content}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 text-right">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      <div className="shrink-0 h-7 w-7 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-md shadow-violet-500/30">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="max-w-[85%]">
        <div className="bg-white/[0.05] border border-white/10 text-slate-200 rounded-[22px] rounded-tl-sm px-4 py-2.5 text-sm">
          {isEmpty ? <TypingDots /> : renderContent(message.content)}
          {message.isStreaming && !isEmpty && (
            <span className="inline-block h-3.5 w-0.5 bg-violet-400 animate-pulse ml-0.5 align-middle" />
          )}
        </div>
        <div className="text-[10px] text-slate-500 mt-1">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    </div>
  );
}

// ─── Live stats card ──────────────────────────────────────────────────────────

function StatsCard({ stats }: { stats: CopilotStats }) {
  return (
    <div className="rounded-[26px] border border-violet-400/20 bg-white/[0.04] px-5 py-5 shadow-lg">
      <div className="flex items-center gap-2 text-violet-300 text-[10px] font-semibold uppercase tracking-[0.16em] mb-3">
        <Sparkles className="h-3.5 w-3.5" />
        Live workspace insight
      </div>
      <div className="text-2xl font-bold text-white">
        {stats.failing > 0 ? `${stats.failing} failing tests` : "All tests passing"}
      </div>
      {stats.hotspot && stats.failing > 0 && (
        <div className="text-sm text-slate-300 mt-1">
          Largest hotspot:{" "}
          <span className="text-white font-medium">{stats.hotspot}</span>
        </div>
      )}
      {stats.healed > 0 && (
        <div className="text-sm text-slate-400 mt-0.5">
          {stats.healed} test{stats.healed !== 1 ? "s" : ""} previously self-healed
        </div>
      )}
    </div>
  );
}

// ─── Empty / welcome state ────────────────────────────────────────────────────

function WelcomeState({
  stats,
  quickActions,
  onChip,
}: {
  stats: CopilotStats | null;
  quickActions: QuickAction[];
  onChip: (prompt: string) => void;
}) {
  return (
    <div className="space-y-5 pb-2">
      {/* Intro message from copilot */}
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 h-7 w-7 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-md shadow-violet-500/30">
          <Bot className="h-3.5 w-3.5 text-white" />
        </div>
        <div className="max-w-[80%] bg-white/[0.05] border border-white/10 text-slate-200 rounded-[24px] rounded-tl-sm px-4 py-4 text-sm leading-relaxed shadow-sm">
          {stats && stats.failing > 0 ? (
            <>
              I detected{" "}
              <span className="font-semibold text-white">{stats.failing} failing tests</span>
              {stats.hotspot ? (
                <>
                  {" "}— <span className="font-semibold text-white">{stats.hotspot}</span> is your
                  biggest failure cluster.
                </>
              ) : "."}
              {" "}Want me to analyze, triage, or start fixing them?
            </>
          ) : (
            <>
              I'm your TestMind Copilot. I can generate tests, write test plans, analyze
              failures, and guide you through any workflow.
            </>
          )}
        </div>
      </div>

      {/* Live stats card */}
      {stats && <StatsCard stats={stats} />}

      {/* Quick actions */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Suggested actions
        </p>
        <div className="grid gap-3">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                onClick={() => onChip(action.prompt)}
                className="group flex items-center gap-3 rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-400/40 hover:bg-violet-500/10"
              >
                <div className="shrink-0 rounded-2xl bg-violet-500/10 p-2 text-violet-300 group-hover:bg-violet-500/20 transition-colors">
                  <Icon className="h-4 w-4" />
                </div>
                <span className="text-sm text-slate-200 group-hover:text-white transition-colors">
                  {action.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function CopilotPanel() {
  const { isOpen, messages, isStreaming, stats, close, send, clear, currentRoute } = useCopilot();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const quickActions = getQuickActions(currentRoute, stats);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const val = textareaRef.current?.value.trim();
    if (!val || isStreaming) return;
    textareaRef.current!.value = "";
    textareaRef.current!.style.height = "auto";
    send(val);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.aside
          key="copilot-panel"
          initial={{ x: "110%" }}
          animate={{ x: 0 }}
          exit={{ x: "110%" }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed right-4 top-6 bottom-6 w-[390px] z-40 bg-[#081224]/95 backdrop-blur-xl text-white flex flex-col shadow-[0_20px_60px_rgba(0,0,0,0.6)] border border-white/10 rounded-[32px] overflow-hidden"
        >
          {/* Header */}
          <div className="shrink-0 border-b border-white/10 bg-gradient-to-r from-indigo-500/20 via-violet-500/10 to-cyan-500/10 backdrop-blur-md px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="relative shrink-0 h-11 w-11 flex items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-blue-500 shadow-lg shadow-violet-500/30">
                <Bot className="h-5 w-5 text-white" />
                <span className="absolute inset-0 rounded-2xl bg-violet-400/20 blur-md animate-pulse" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold tracking-wide text-white leading-none">
                  TestMind Copilot
                </h2>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  AI triage, generation, and recovery
                </p>
              </div>
              <button
                onClick={clear}
                title="Clear chat"
                className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={close}
                title="Close"
                className="h-8 w-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Messages / welcome */}
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5 min-h-0">
            {messages.length === 0 ? (
              <WelcomeState
                stats={stats}
                quickActions={quickActions}
                onChip={(prompt) => send(prompt)}
              />
            ) : (
              messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-white/10 px-5 pt-3 pb-5 bg-[#081224]/80">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 focus-within:border-violet-400/50 focus-within:ring-2 focus-within:ring-violet-500/20 transition-all">
              <textarea
                ref={textareaRef}
                rows={1}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                disabled={isStreaming}
                placeholder="Ask me to fix, analyze, or generate tests…"
                className="flex-1 resize-none bg-transparent text-sm text-white placeholder:text-slate-500 outline-none disabled:opacity-50 leading-relaxed"
                style={{ maxHeight: "120px" }}
              />
              <button
                onClick={handleSend}
                disabled={isStreaming}
                className="shrink-0 h-8 w-8 flex items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-blue-500 text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity shadow-md shadow-violet-500/30"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-2 text-[10px] text-slate-600 text-center">
              Enter to send · Shift+Enter for new line
            </p>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

// ─── Toggle button ────────────────────────────────────────────────────────────

export function CopilotToggleButton() {
  const { isOpen, toggle, stats } = useCopilot();
  const hasFailing = (stats?.failing ?? 0) > 0;

  return (
    <div className="fixed bottom-5 right-5 z-50">
      {/* Pulse ring when there are failures and panel is closed */}
      {hasFailing && !isOpen && (
        <span className="absolute inset-0 rounded-full bg-violet-500/40 animate-ping" />
      )}
      <motion.button
        onClick={toggle}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className="relative h-12 w-12 rounded-full bg-gradient-to-br from-violet-500 to-blue-500 text-white shadow-lg shadow-violet-500/40 flex items-center justify-center transition-opacity"
        title={isOpen ? "Close Copilot" : "Open TestMind Copilot"}
      >
        <AnimatePresence mode="wait">
          {isOpen ? (
            <motion.span
              key="x"
              initial={{ rotate: -90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: 90, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <X className="h-5 w-5" />
            </motion.span>
          ) : (
            <motion.span
              key="bot"
              initial={{ rotate: 90, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              exit={{ rotate: -90, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Bot className="h-5 w-5" />
            </motion.span>
          )}
        </AnimatePresence>
        {/* Badge dot when failures exist */}
        {hasFailing && !isOpen && (
          <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-rose-500 border-2 border-white flex items-center justify-center">
            <span className="text-[7px] font-bold leading-none">!</span>
          </span>
        )}
      </motion.button>
    </div>
  );
}
