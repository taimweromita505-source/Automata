import { useRouter } from "expo-router";
import {
  Bell,
  Brain,
  CalendarBlank,
  ChatCircleText,
  Code,
  DeviceMobile,
  DiscordLogo,
  EnvelopeSimple,
  FolderSimple,
  Funnel,
  GitBranch,
  Globe,
  GoogleLogo,
  MagnifyingGlass,
  Repeat,
  SlackLogo,
  Table,
  TelegramLogo,
  TextT,
  Timer,
  FileMagnifyingGlass,
} from "phosphor-react-native";
import React from "react";
import { Pressable, Text, View } from "react-native";

import { Credential, Step, StepType } from "@/src/api";
import { Chips, Field } from "@/src/components/ui";
import { fonts, makeStyles, radius, spacing } from "@/src/theme";

type FieldSpec = {
  key: string;
  label: string;
  kind?: "text" | "multiline" | "number" | "chips" | "credential" | "code";
  options?: string[];
  placeholder?: string;
  credTypes?: string[];
  optional?: boolean;
  showIf?: (c: Record<string, any>) => boolean;
  def?: any;
};

const TEXT = (key: string, label: string, placeholder = "", extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, placeholder, ...extra });
const ML = (key: string, label: string, placeholder = "", extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, placeholder, kind: "multiline", ...extra });
const CRED = (types: string[], optional = false): FieldSpec => ({ key: "credential", label: "Credential", kind: "credential", credTypes: types, optional });

export const STEP_FIELDS: Record<StepType, FieldSpec[]> = {
  http: [
    { key: "method", label: "Method", kind: "chips", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    TEXT("url", "URL", "https://api.example.com/data"),
    CRED(["bearer", "api_key", "basic", "custom", "google"], true),
    TEXT("headers", "Headers (JSON)", '{"Accept": "application/json"}'),
    ML("body", "Body", '{"text": "{{prev}}"}'),
  ],
  llm: [ML("prompt", "Prompt", "", { def: "Summarize this:\n{{prev}}" }), ML("system", "System instructions (optional)")],
  code: [{ key: "code", label: "Python code", kind: "code", def: "# vars: input, prev, data (JSON of prev), steps\nresult = prev.upper()" }],
  set: [ML("value", "Value", "", { def: "{{prev}}" })],
  if: [
    TEXT("left", "Value to check", "{{prev}}"),
    { key: "operator", label: "Operator", kind: "chips", options: ["contains", "not_contains", "equals", "not_equals", "regex", "gt", "lt", "empty", "not_empty"] },
    TEXT("right", "Compare with", "urgent"),
    { key: "on_false", label: "If false", kind: "chips", options: ["stop", "skip"] },
    { key: "skip_count", label: "Steps to skip", kind: "number", def: 1, showIf: (c) => c.on_false === "skip" },
  ],
  loop: [TEXT("source", "List to loop over", "{{prev}}"), { key: "max_items", label: "Max items (≤50)", kind: "number", def: 25 }],
  filter: [TEXT("contains", "Continue only if output contains")],
  delay: [{ key: "seconds", label: "Seconds (max 60)", kind: "number", def: 5 }],
  scrape: [TEXT("url", "Page URL", "https://news.ycombinator.com"), TEXT("selector", "CSS selector (optional)", ".titleline > a")],
  search: [TEXT("query", "Search query", "latest AI news"), { key: "limit", label: "Results", kind: "number", def: 8 }],
  telegram: [CRED(["telegram"]), TEXT("chat_id", "Chat ID (optional override)"), ML("text", "Message", "", { def: "{{prev}}" })],
  slack: [CRED(["slack"]), ML("text", "Message", "", { def: "{{prev}}" })],
  discord: [CRED(["discord"]), ML("text", "Message", "", { def: "{{prev}}" })],
  email: [
    CRED(["resend"]),
    TEXT("to", "To (comma separated)", "me@example.com"),
    TEXT("subject", "Subject", "Daily report"),
    TEXT("from", "From (optional override)"),
    ML("text", "Body", "", { def: "{{prev}}" }),
  ],
  sheets: [
    CRED(["google"]),
    { key: "action", label: "Action", kind: "chips", options: ["read", "append"] },
    TEXT("spreadsheet_id", "Spreadsheet ID", "from the sheet URL"),
    TEXT("range", "Range", "Sheet1!A:D", { def: "Sheet1" }),
    ML("values", "Row values (JSON rows or comma text)", '["{{now}}", "{{prev}}"]', { showIf: (c) => c.action === "append" }),
  ],
  gmail: [CRED(["google"]), TEXT("to", "To", "me@example.com"), TEXT("subject", "Subject"), ML("text", "Body", "", { def: "{{prev}}" })],
  drive: [CRED(["google"]), TEXT("query", "Search (name or Drive query)", "report")],
  calendar: [
    CRED(["google"]),
    { key: "action", label: "Action", kind: "chips", options: ["list", "create"] },
    TEXT("calendar_id", "Calendar ID", "primary", { def: "primary" }),
    TEXT("summary", "Event title", "", { showIf: (c) => c.action === "create" }),
    TEXT("start", "Start (ISO)", "2026-07-01T09:00:00+02:00", { showIf: (c) => c.action === "create" }),
    TEXT("end", "End (ISO)", "2026-07-01T10:00:00+02:00", { showIf: (c) => c.action === "create" }),
  ],
  device: [
    { key: "action", label: "Action", kind: "chips", options: ["notify", "clipboard", "open_url", "share", "vibrate"] },
    TEXT("title", "Title", "Automata", { showIf: (c) => c.action === "notify" }),
    ML("text", "Text", "", { def: "{{prev}}" }),
    TEXT("url", "URL", "https://...", { showIf: (c) => c.action === "open_url" }),
  ],
};

export function defaultConfig(type: StepType): Record<string, any> {
  const cfg: Record<string, any> = {};
  STEP_FIELDS[type].forEach((f) => {
    cfg[f.key] = f.def ?? (f.kind === "chips" ? f.options![0] : "");
  });
  return cfg;
}

export function stepSummary(s: Step): string {
  const c = s.config;
  switch (s.type) {
    case "http":
      return `${c.method ?? "GET"} ${c.url || "(no url)"}`;
    case "if":
      return `if ${c.left || "{{prev}}"} ${c.operator} ${c.right ?? ""} else ${c.on_false}`;
    case "loop":
      return `for each item in ${c.source || "{{prev}}"} → next step`;
    case "delay":
      return `Wait ${c.seconds ?? 0}s`;
    case "filter":
      return `Continue if contains "${c.contains ?? ""}"`;
    case "code":
      return (c.code || "").split("\n").filter((l: string) => l && !l.startsWith("#"))[0] || "(empty)";
    case "scrape":
      return `${c.url || "(no url)"} ${c.selector || ""}`;
    case "search":
      return c.query || "{{prev}}";
    case "device":
      return `${c.action}: ${c.text || c.url || ""}`;
    case "sheets":
    case "calendar":
      return `${c.action} · ${c.credential || "no credential"}`;
    case "llm":
      return c.prompt || "(no prompt)";
    case "set":
      return c.value || "(empty)";
    default:
      return `${c.credential || "no credential"} · ${c.text || c.to || c.query || ""}`;
  }
}

export function StepIcon({ type, color, size = 20 }: { type: StepType; color: string; size?: number }) {
  const p = { size, color };
  const map: Record<StepType, React.ReactElement> = {
    http: <Globe {...p} />,
    llm: <Brain {...p} />,
    code: <Code {...p} />,
    set: <TextT {...p} />,
    if: <GitBranch {...p} />,
    loop: <Repeat {...p} />,
    filter: <Funnel {...p} />,
    delay: <Timer {...p} />,
    scrape: <FileMagnifyingGlass {...p} />,
    search: <MagnifyingGlass {...p} />,
    telegram: <TelegramLogo {...p} />,
    slack: <SlackLogo {...p} />,
    discord: <DiscordLogo {...p} />,
    email: <EnvelopeSimple {...p} />,
    sheets: <Table {...p} />,
    gmail: <GoogleLogo {...p} />,
    drive: <FolderSimple {...p} />,
    calendar: <CalendarBlank {...p} />,
    device: <DeviceMobile {...p} />,
  };
  return map[type] ?? <ChatCircleText {...p} />;
}

export { Bell };

export function StepForm({
  step,
  credentials,
  onChange,
  onOpenVault,
}: {
  step: Step;
  credentials: Credential[];
  onChange: (config: Record<string, any>) => void;
  onOpenVault: () => void;
}) {
  const styles = useStyles();
  const c = step.config;
  const set = (k: string, v: any) => onChange({ ...c, [k]: v });
  return (
    <View>
      {STEP_FIELDS[step.type]
        .filter((f) => !f.showIf || f.showIf(c))
        .map((f) => {
          const tid = `step-field-${f.key}`;
          if (f.kind === "chips") {
            return (
              <View key={f.key}>
                <Text style={styles.label}>{f.label.toUpperCase()}</Text>
                <Chips testID={tid} options={f.options!} value={c[f.key] ?? f.options![0]} onChange={(v) => set(f.key, v)} />
              </View>
            );
          }
          if (f.kind === "credential") {
            const list = credentials.filter((cr) => f.credTypes!.includes(cr.type)).map((cr) => cr.name);
            const options = f.optional ? ["none", ...list] : list;
            return (
              <View key={f.key}>
                <Text style={styles.label}>{`CREDENTIAL (${f.credTypes!.join(" / ").toUpperCase()})`}</Text>
                {options.length ? (
                  <Chips testID={tid} options={options} value={c.credential || (f.optional ? "none" : "")} onChange={(v) => set("credential", v === "none" ? "" : v)} />
                ) : null}
                {list.length === 0 && (
                  <Pressable style={styles.vault} onPress={onOpenVault} testID="step-open-vault-button">
                    <Text style={styles.vaultText}>{`No ${f.credTypes!.join("/")} credential yet. Tap to add one in the vault.`}</Text>
                  </Pressable>
                )}
              </View>
            );
          }
          return (
            <Field
              key={f.key}
              label={f.label}
              value={c[f.key] === undefined || c[f.key] === null ? "" : String(c[f.key])}
              onChangeText={(v) => set(f.key, f.kind === "number" ? (v === "" ? "" : Number(v.replace(/[^0-9]/g, "")) || 0) : v)}
              placeholder={f.placeholder}
              multiline={f.kind === "multiline" || f.kind === "code"}
              keyboardType={f.kind === "number" ? "number-pad" : "default"}
              style={f.kind === "code" ? styles.code : undefined}
              testID={tid}
            />
          );
        })}
    </View>
  );
}

export function useOpenVault() {
  const router = useRouter();
  return () => router.push("/credentials");
}

const useStyles = makeStyles((c) => ({
  label: { color: c.onSurfaceTertiary, fontFamily: fonts.displaySemi, fontSize: 13, letterSpacing: 1, marginBottom: spacing.sm },
  vault: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.brandPrimary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  vaultText: { color: c.onBrandTertiary, fontFamily: fonts.medium, fontSize: 13 },
  code: { fontFamily: fonts.mono, fontSize: 13, minHeight: 140 },
}));
