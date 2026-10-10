import { useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { ArrowUp, Broom, CheckCircle, CircleNotch, Lightning, Robot, XCircle } from "phosphor-react-native";
import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ChatMessage, Settings, streamAgent, ToolCall } from "@/src/api";
import { useToast } from "@/src/components/toast";
import { executeDeviceActions } from "@/src/device";
import { usesNativeTabs } from "@/src/navigation";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

const SUGGESTIONS = [
  "Search the web for today's top AI news and give me 5 bullet points",
  "Every morning fetch Hacker News, summarize the top 5 and send it to my Telegram",
  "Write Python to convert 100 USD to EUR using a free API and run it",
  "Remind me with a phone notification every hour to drink water",
];

const TOOL_LABEL: Record<string, string> = {
  create_workflow: "Create workflow",
  update_workflow: "Update workflow",
  run_workflow: "Run workflow",
  list_workflows: "List workflows",
  set_workflow_active: "Toggle workflow",
  list_runs: "List runs",
  n8n_list_workflows: "n8n: list workflows",
  web_search: "Web search",
  fetch_url: "Read web page",
  http_request: "API request",
  run_code: "Run code",
  run_step: "Run action",
  list_credentials: "Check credentials",
};

function TaskCard({ call }: { call: ToolCall }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const color = call.status === "success" ? colors.success : call.status === "failed" ? colors.error : colors.warning;
  const summary =
    call.status === "running"
      ? "Executing..."
      : typeof call.result === "string"
        ? call.result
        : call.result?.output !== undefined
          ? String(call.result.output)
          : call.result?.name
          ? `${call.result.name} (${call.result.steps ?? 0} steps)`
          : call.result?.status
            ? `Run ${call.result.status}`
            : Array.isArray(call.result)
              ? `${call.result.length} item(s)`
              : "Done";
  return (
    <Animated.View entering={FadeInDown.duration(250)} style={styles.task} testID={`task-card-${call.id}`}>
      <View style={styles.taskHead}>
        <Lightning size={16} color={colors.brandPrimary} weight="fill" />
        <Text style={styles.taskTitle}>{TOOL_LABEL[call.name] ?? call.name}</Text>
        {call.status === "running" ? (
          <ActivityIndicator size="small" color={color} />
        ) : call.status === "success" ? (
          <CheckCircle size={18} color={color} weight="fill" />
        ) : (
          <XCircle size={18} color={color} weight="fill" />
        )}
        <Text style={[styles.taskStatus, { color }]}>{call.status.toUpperCase()}</Text>
      </View>
      <Text style={styles.taskBody} numberOfLines={3}>
        {summary}
      </Text>
    </Animated.View>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const styles = useStyles();
  const isUser = m.role === "user";
  return (
    <View style={[styles.row, isUser && styles.rowUser]} testID={`chat-message-${m.role}`}>
      {m.tool_calls?.map((c) => <TaskCard key={c.id} call={c} />)}
      {m.content ? (
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAi]}>
          <Text style={[styles.msg, isUser && styles.msgUser]} selectable>
            {m.content}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default function AgentScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  // JS tab bar height (49 native + inset, 64 on web); NativeTabs float so no offset is needed
  const tabBarHeight = usesNativeTabs ? 0 : Platform.OS === "web" ? 64 : 49 + insets.bottom;
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modelLabel, setModelLabel] = useState("");
  const listRef = useRef<FlatList<ChatMessage>>(null);

  useFocusEffect(
    useCallback(() => {
      api<ChatMessage[]>("/agent/messages")
        .then(setMessages)
        .catch(() => toast("Could not load chat", "error"))
        .finally(() => setLoading(false));
      api<Settings>("/settings")
        .then((s) => setModelLabel(s.provider === "local" ? `LOCAL / ${s.local_model || "unset"}` : s.emergent_model))
        .catch(() => {});
    }, [toast]),
  );

  const scrollEnd = () => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);

  const send = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || sending) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setInput("");
    setSending(true);
    const now = new Date().toISOString();
    const draftId = `draft-${Date.now()}`;
    setMessages((p) => [
      ...p,
      { id: `u-${Date.now()}`, role: "user", content: msg, tool_calls: [], created_at: now },
      { id: draftId, role: "assistant", content: "", tool_calls: [], created_at: now },
    ]);
    scrollEnd();
    const update = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((p) => p.map((m) => (m.id === draftId ? fn(m) : m)));
    try {
      await streamAgent(msg, (e) => {
        if (e.type === "delta") update((m) => ({ ...m, content: m.content + e.text }));
        else if (e.type === "tool_start") update((m) => ({ ...m, tool_calls: [...m.tool_calls, e.call] }));
        else if (e.type === "tool_result")
          update((m) => ({ ...m, tool_calls: m.tool_calls.map((c) => (c.id === e.call.id ? e.call : c)) }));
        else if (e.type === "error") toast(e.text, "error");
        else if (e.type === "device_action") executeDeviceActions(e.actions, toast);
        else if (e.type === "done") update(() => e.message);
        scrollEnd();
      });
    } catch (err: any) {
      toast(err?.message ?? "Agent failed", "error");
      update((m) => ({ ...m, content: m.content || "Request failed. Check your connection and LLM settings." }));
    } finally {
      setSending(false);
    }
  };

  const clear = async () => {
    await api("/agent/messages", { method: "DELETE" }).catch(() => {});
    setMessages([]);
    toast("Conversation cleared", "success");
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>AGENT</Text>
          <Text style={styles.subtitle} testID="agent-model-label">{modelLabel || "..."}</Text>
        </View>
        <Pressable onPress={clear} style={styles.headerBtn} testID="agent-clear-button" hitSlop={8}>
          <Broom size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "translate-with-padding"}
        keyboardVerticalOffset={-tabBarHeight}
        style={{ flex: 1 }}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.brandPrimary} />
          </View>
        ) : messages.length === 0 ? (
          <ScrollView contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled">
            <View style={styles.emptyIcon}>
              <Robot size={40} color={colors.brandPrimary} weight="duotone" />
            </View>
            <Text style={styles.emptyTitle}>Automate anything</Text>
            <Text style={styles.emptyText}>
              Describe a task in plain words. The agent builds and runs workflows for you.
            </Text>
            {SUGGESTIONS.map((s, i) => (
              <Animated.View key={s} entering={FadeInDown.delay(i * 70)} style={{ alignSelf: "stretch" }}>
                <Pressable style={styles.suggest} onPress={() => send(s)} testID={`agent-suggestion-${i}`}>
                  <Lightning size={16} color={colors.brandPrimary} />
                  <Text style={styles.suggestText}>{s}</Text>
                </Pressable>
              </Animated.View>
            ))}
          </ScrollView>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <Bubble m={item} />}
            contentContainerStyle={styles.list}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            keyboardShouldPersistTaps="handled"
            testID="agent-message-list"
            ListFooterComponent={
              sending ? (
                <View style={styles.thinking} testID="agent-thinking">
                  <CircleNotch size={14} color={colors.brandPrimary} />
                  <Text style={styles.thinkingText}>Agent working...</Text>
                </View>
              ) : null
            }
          />
        )}
        <View style={[styles.inputBar, { paddingBottom: bottomChrome + spacing.sm }]}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask the agent to automate..."
            placeholderTextColor={colors.muted}
            style={styles.input}
            multiline
            testID="agent-chat-input"
          />
          <Pressable
            onPress={() => send()}
            disabled={!input.trim() || sending}
            style={[styles.sendBtn, (!input.trim() || sending) && { opacity: 0.4 }]}
            testID="agent-send-button"
          >
            {sending ? (
              <ActivityIndicator color={colors.onBrandPrimary} size="small" />
            ) : (
              <ArrowUp size={22} color={colors.onBrandPrimary} weight="bold" />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  title: { color: c.onSurface, fontFamily: fonts.display, fontSize: 28, letterSpacing: 1.5 },
  subtitle: { color: c.brandPrimary, fontFamily: fonts.mono, fontSize: 12 },
  headerBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: spacing.lg, gap: spacing.md },
  row: { alignItems: "flex-start", gap: spacing.sm },
  rowUser: { alignItems: "flex-end" },
  bubble: { maxWidth: "88%", padding: spacing.md, borderRadius: radius.lg },
  bubbleAi: { backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border, borderTopLeftRadius: radius.sm },
  bubbleUser: { backgroundColor: c.brandPrimary, borderTopRightRadius: radius.sm },
  msg: { color: c.onSurface, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  msgUser: { color: c.onBrandPrimary, fontFamily: fonts.medium },
  task: {
    alignSelf: "stretch",
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderLeftWidth: 3,
    borderLeftColor: c.brandPrimary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  taskHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  taskTitle: { flex: 1, color: c.onSurface, fontFamily: fonts.display, fontSize: 16, letterSpacing: 0.5 },
  taskStatus: { fontFamily: fonts.display, fontSize: 12, letterSpacing: 1 },
  taskBody: { color: c.onSurfaceTertiary, fontFamily: fonts.mono, fontSize: 12 },
  thinking: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingTop: spacing.sm },
  thinkingText: { color: c.muted, fontFamily: fonts.mono, fontSize: 12 },
  empty: { padding: spacing.xl, alignItems: "flex-start", gap: spacing.md },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.lg,
    backgroundColor: c.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xl,
  },
  emptyTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 30 },
  emptyText: { color: c.onSurfaceTertiary, fontFamily: fonts.body, fontSize: 15, lineHeight: 22, marginBottom: spacing.sm },
  suggest: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 48,
  },
  suggestText: { flex: 1, color: c.onSurfaceSecondary, fontFamily: fonts.body, fontSize: 14 },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surface,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    backgroundColor: c.surfaceTertiary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    color: c.onSurface,
    fontFamily: fonts.body,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingTop: 13,
    paddingBottom: 13,
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
}));
