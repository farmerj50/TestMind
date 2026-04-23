import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { useApi } from "../lib/api";

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  timestamp: number;
};

export type CopilotStats = {
  failing: number;
  healed: number;
  hotspot: string | null;
};

type State = {
  isOpen: boolean;
  messages: Message[];
  isStreaming: boolean;
  stats: CopilotStats | null;
};

type Action =
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "TOGGLE" }
  | { type: "ADD_MESSAGE"; message: Message }
  | { type: "APPEND_DELTA"; delta: string }
  | { type: "FINISH_STREAM" }
  | { type: "CLEAR" }
  | { type: "SET_STATS"; stats: CopilotStats };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "OPEN":
      return { ...state, isOpen: true };
    case "CLOSE":
      return { ...state, isOpen: false };
    case "TOGGLE":
      return { ...state, isOpen: !state.isOpen };
    case "ADD_MESSAGE":
      return { ...state, messages: [...state.messages, action.message] };
    case "APPEND_DELTA": {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") return state;
      msgs[msgs.length - 1] = { ...last, content: last.content + action.delta, isStreaming: true };
      return { ...state, messages: msgs };
    }
    case "FINISH_STREAM": {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, isStreaming: false };
      }
      return { ...state, messages: msgs, isStreaming: false };
    }
    case "CLEAR":
      return { ...state, messages: [] };
    case "SET_STATS":
      return { ...state, stats: action.stats };
    default:
      return state;
  }
}

type CopilotContextValue = {
  isOpen: boolean;
  messages: Message[];
  isStreaming: boolean;
  stats: CopilotStats | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  send: (content: string) => Promise<void>;
  clear: () => void;
  currentRoute: string;
};

const CopilotContext = createContext<CopilotContextValue | null>(null);

function extractProjectId(pathname: string): string | undefined {
  const m = pathname.match(/\/projects\/([^/]+)/);
  return m?.[1];
}

export function CopilotProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    isOpen: false,
    messages: [],
    isStreaming: false,
    stats: null,
  });
  const { apiFetch, apiFetchRaw } = useApi();
  const location = useLocation();
  const streamingRef = useRef(false);

  // Fetch workspace stats once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        type Summary = { counts: { failed: number; total: number }; healedCount?: number };
        type Project = { id: string; name: string };

        const [summary, projectsRes] = await Promise.all([
          apiFetch<Summary>("/reports/summary"),
          apiFetch<{ projects: Project[] }>("/projects"),
        ]);

        if (cancelled) return;

        const projects = projectsRes.projects ?? [];
        let hotspot: string | null = null;

        // Find the project with the most failures (up to 5 concurrent calls)
        if (projects.length > 0) {
          const slice = projects.slice(0, 5);
          const perProject = await Promise.allSettled(
            slice.map((p) =>
              apiFetch<Summary>(`/reports/summary?projectId=${encodeURIComponent(p.id)}`).then(
                (s) => ({ name: p.name, failed: s.counts.failed, total: s.counts.total })
              )
            )
          );
          if (!cancelled) {
            let maxFailed = 0;
            perProject.forEach((r) => {
              if (r.status === "fulfilled" && r.value.failed > maxFailed) {
                maxFailed = r.value.failed;
                hotspot = r.value.name;
              }
            });
          }
        }

        if (!cancelled) {
          dispatch({
            type: "SET_STATS",
            stats: {
              failing: summary.counts.failed,
              healed: summary.healedCount ?? 0,
              hotspot,
            },
          });
        }
      } catch {
        // stats are best-effort
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch]);

  const open = useCallback(() => dispatch({ type: "OPEN" }), []);
  const close = useCallback(() => dispatch({ type: "CLOSE" }), []);
  const toggle = useCallback(() => dispatch({ type: "TOGGLE" }), []);
  const clear = useCallback(() => dispatch({ type: "CLEAR" }), []);

  const send = useCallback(
    async (content: string) => {
      if (streamingRef.current) return;
      streamingRef.current = true;

      const userMsg: Message = {
        id: `${Date.now()}-u`,
        role: "user",
        content,
        timestamp: Date.now(),
      };
      dispatch({ type: "ADD_MESSAGE", message: userMsg });
      dispatch({
        type: "ADD_MESSAGE",
        message: { id: `${Date.now()}-a`, role: "assistant", content: "", isStreaming: true, timestamp: Date.now() },
      });

      const route = location.pathname;
      const projectId = extractProjectId(route);

      // Build history excluding the blank placeholder we just added
      const history = state.messages
        .slice(-9)
        .map((m) => ({ role: m.role, content: m.content }));
      history.push({ role: "user", content });

      try {
        const res = await apiFetchRaw("/copilot/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ messages: history, context: { route, projectId } }),
        });

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") {
              dispatch({ type: "FINISH_STREAM" });
              streamingRef.current = false;
              return;
            }
            try {
              const parsed = JSON.parse(raw);
              if (parsed.delta) dispatch({ type: "APPEND_DELTA", delta: parsed.delta });
              if (parsed.error) {
                dispatch({ type: "APPEND_DELTA", delta: `\n\n_Error: ${parsed.error}_` });
                dispatch({ type: "FINISH_STREAM" });
                streamingRef.current = false;
                return;
              }
            } catch {
              // skip malformed SSE line
            }
          }
        }
      } catch {
        dispatch({ type: "APPEND_DELTA", delta: "_Something went wrong. Please try again._" });
      } finally {
        dispatch({ type: "FINISH_STREAM" });
        streamingRef.current = false;
      }
    },
    [apiFetchRaw, location.pathname, state.messages]
  );

  return (
    <CopilotContext.Provider
      value={{ ...state, open, close, toggle, send, clear, currentRoute: location.pathname }}
    >
      {children}
    </CopilotContext.Provider>
  );
}

export function useCopilot() {
  const ctx = useContext(CopilotContext);
  if (!ctx) throw new Error("useCopilot must be used inside CopilotProvider");
  return ctx;
}
