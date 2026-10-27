import { fetch as expoFetch } from "expo/fetch";
import { router } from "expo-router";

import { storage } from "@/src/utils/storage";

export const BASE = process.env.EXPO_PUBLIC_BACKEND_URL as string;
export const API = `${BASE}/api`;

export type StepType =
  | "http" | "llm" | "delay" | "set" | "filter" | "code" | "scrape" | "search" | "if" | "loop"
  | "telegram" | "slack" | "discord" | "email" | "sheets" | "gmail" | "drive" | "calendar" | "device";
export type Step = { id: string; type: StepType; name: string; config: Record<string, any> };
export type Trigger = {
  type: "manual" | "schedule" | "webhook" | "location";
  interval_minutes: number;
  latitude?: number | null;
  longitude?: number | null;
  radius?: number;
  event?: "enter" | "exit";
};
export type DeviceAction = { action: "notify" | "clipboard" | "open_url" | "share" | "vibrate"; title: string; text: string; url: string };
export type Credential = { id: string; name: string; type: string; created_at: string; fields: Record<string, string> };
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
  device_actions: DeviceAction[];
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
export type Plan = {
  pro: boolean;
  billing_mode: "open" | "revenuecat" | string;
  workflows: number;
  usage_today: { agent: number; llm: number; code: number };
  limits: { workflows: number | null; agent_daily: number | null; llm_daily: number; code_daily: number };
};

// Per-install identity: every device keeps its own workflows, credentials and settings.
const DEVICE_KEY = "automata_device_id";
let devicePromise: Promise<string> | null = null;
export function getDeviceId(): Promise<string> {
  if (!devicePromise) {
    devicePromise = (async () => {
      const existing = await storage.secureGet(DEVICE_KEY, null);
      if (existing) return String(existing);
      const id = "dev-" + Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      await storage.secureSet(DEVICE_KEY, id);
      return id;
    })();
  }
  return devicePromise;
}

/** Thrown when the server answers 402: the feature needs Automata Pro. The paywall is opened automatically. */
export class ProRequiredError extends Error {}

let lastPaywallAt = 0;
/** Opens the paywall (debounced so parallel 402s do not stack several modals). */
export function openPaywall(feature?: string) {
  const now = Date.now();
  if (now - lastPaywallAt < 1500) return;
  lastPaywallAt = now;
  try {
    router.push({ pathname: "/paywall", params: feature ? { feature } : {} });
  } catch {}
}

function featureFrom(detail: string) {
  return detail.split(" requires Automata Pro")[0] || detail;
}

export async function api<T>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", "X-Device-Id": await getDeviceId() },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  const detail = data?.detail ? String(data.detail) : `Request failed (${res.status})`;
  if (res.status === 402) {
    openPaywall(featureFrom(detail));
    throw new ProRequiredError(detail);
  }
  if (!res.ok) throw new Error(detail);
  return data as T;
}

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall }
  | { type: "error"; text: string }
  | { type: "device_action"; actions: DeviceAction[] }
  | { type: "paywall"; feature: string; text: string }
  | { type: "done"; message: ChatMessage };

export async function streamAgent(message: string, onEvent: (e: AgentEvent) => void) {
  const res = await expoFetch(`${API}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Device-Id": await getDeviceId() },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    let detail = `Agent request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.detail) detail = String(data.detail);
    } catch {}
    if (res.status === 402) {
      openPaywall(featureFrom(detail));
      throw new ProRequiredError(detail);
    }
    throw new Error(detail);
  }
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
          const ev = JSON.parse(chunk.slice(5).trim()) as AgentEvent;
          if (ev.type === "paywall") openPaywall(ev.feature); // an agent tool needed Pro
          onEvent(ev);
        } catch {}
      }
    }
  }
}

export const STEP_META: Record<StepType, { label: string; hint: string; group: string }> = {
  http: { label: "HTTP Request", hint: "Call any REST API, with a saved credential", group: "Core" },
  llm: { label: "AI Agent", hint: "Prompt an LLM with data", group: "Core" },
  code: { label: "Code (Python)", hint: "Run custom Python, set result", group: "Core" },
  set: { label: "Set / Compose", hint: "Build text from templates", group: "Core" },
  if: { label: "If / Else", hint: "Branch: stop or skip steps", group: "Logic" },
  loop: { label: "Loop", hint: "Repeat the next step for each item", group: "Logic" },
  filter: { label: "Filter", hint: "Stop unless output matches", group: "Logic" },
  delay: { label: "Delay", hint: "Wait a few seconds", group: "Logic" },
  scrape: { label: "Web Scraper", hint: "Read text from any web page", group: "Web" },
  search: { label: "Web Search", hint: "Search the web", group: "Web" },
  telegram: { label: "Telegram", hint: "Send a bot message", group: "Messaging" },
  slack: { label: "Slack", hint: "Post via incoming webhook", group: "Messaging" },
  discord: { label: "Discord", hint: "Post via channel webhook", group: "Messaging" },
  email: { label: "Email (Resend)", hint: "Send email with your Resend key", group: "Messaging" },
  sheets: { label: "Google Sheets", hint: "Read or append rows", group: "Google" },
  gmail: { label: "Gmail", hint: "Send an email from your Gmail", group: "Google" },
  drive: { label: "Google Drive", hint: "List or find files", group: "Google" },
  calendar: { label: "Google Calendar", hint: "List or create events", group: "Google" },
  device: { label: "Phone Action", hint: "Notify, copy, open link, share, vibrate", group: "Phone" },
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
