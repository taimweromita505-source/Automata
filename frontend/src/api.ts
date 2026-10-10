import { fetch as expoFetch } from "expo/fetch";

export const BASE = process.env.EXPO_PUBLIC_BACKEND_URL as string;
export const API = `${BASE}/api`;

export type StepType = "http" | "llm" | "delay" | "set" | "filter";
export type Step = { id: string; type: StepType; name: string; config: Record<string, any> };
export type Trigger = { type: "manual" | "schedule" | "webhook"; interval_minutes: number };
export type Workflow = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  trigger: Trigger;
  steps: Step[];
  last_run_at?: string | null;
  last_status?: string | null;
  next_run_at?: string | null;
  updated_at?: string;
};
export type StepLog = {
  step_id: string;
  name: string;
  type: string;
  status: string;
  output: string;
  error?: string | null;
  duration_ms: number;
};
export type Run = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  trigger: string;
  status: string;
  input: string;
  output: string;
  logs: StepLog[];
  started_at: string;
  finished_at?: string | null;
};
export type Settings = {
  provider: "emergent" | "local";
  emergent_provider: "openai" | "anthropic" | "gemini";
  emergent_model: string;
  local_base_url: string;
  local_model: string;
  local_api_key: string;
  n8n_url: string;
  n8n_api_key: string;
};
export type ToolCall = { id: string; name: string; args: any; status: string; result: any };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: ToolCall[];
  created_at: string;
};
export type N8nWorkflow = { id: string; name: string; active: boolean; updated_at?: string; nodes: number };

export async function api<T>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.detail ? String(data.detail) : `Request failed (${res.status})`);
  return data as T;
}

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall }
  | { type: "error"; text: string }
  | { type: "done"; message: ChatMessage };

export async function streamAgent(message: string, onEvent: (e: AgentEvent) => void) {
  const res = await expoFetch(`${API}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) throw new Error(`Agent request failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (chunk.startsWith("data:")) {
        try {
          onEvent(JSON.parse(chunk.slice(5).trim()));
        } catch {}
      }
    }
  }
}

export const STEP_META: Record<StepType, { label: string; hint: string }> = {
  http: { label: "HTTP Request", hint: "Call any API or URL" },
  llm: { label: "AI Agent", hint: "Prompt an LLM with data" },
  delay: { label: "Delay", hint: "Wait a few seconds" },
  set: { label: "Set / Compose", hint: "Build text from templates" },
  filter: { label: "Filter", hint: "Stop unless output matches" },
};

export const MODELS: Record<Settings["emergent_provider"], string[]> = {
  openai: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"],
  anthropic: ["claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
};

export function timeAgo(iso?: string | null) {
  if (!iso) return "never";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const future = diff < 0;
  const s = Math.abs(diff);
  const v = s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return future ? `in ${v}` : `${v} ago`;
}
