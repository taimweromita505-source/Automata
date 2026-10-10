import { useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { Cloud, Cpu, Plugs } from "phosphor-react-native";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, MODELS, N8nWorkflow, Settings } from "@/src/api";
import { useToast } from "@/src/components/toast";
import { Button, Chips, Field, SectionLabel, Segmented } from "@/src/components/ui";
import { usesNativeTabs } from "@/src/navigation";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

const PROVIDERS: { key: Settings["emergent_provider"]; label: string }[] = [
  { key: "openai", label: "OpenAI" },
  { key: "anthropic", label: "Claude" },
  { key: "gemini", label: "Gemini" },
];

export default function SettingsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingN8n, setTestingN8n] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useFocusEffect(
    useCallback(() => {
      api<Settings>("/settings")
        .then(setS)
        .catch(() => toast("Could not load settings", "error"));
    }, [toast]),
  );

  if (!s) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }

  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });

  const save = async (silent = false) => {
    if (s.provider === "local" && (!s.local_base_url.startsWith("http") || !s.local_model)) {
      toast("Local LLM needs a valid base URL and model", "error");
      return false;
    }
    setSaving(true);
    try {
      await api("/settings", { method: "PUT", body: s });
      if (!silent) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast("Configuration saved", "success");
      }
      return true;
    } catch (e: any) {
      toast(e.message, "error");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testLlm = async () => {
    if (!(await save(true))) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; reply?: string; error?: string }>("/llm/test", { method: "POST" });
      setTestResult({ ok: r.ok, text: r.ok ? `Connected. Reply: ${r.reply}` : r.error ?? "Failed" });
    } catch (e: any) {
      setTestResult({ ok: false, text: e.message });
    } finally {
      setTesting(false);
    }
  };

  const testN8n = async () => {
    if (!(await save(true))) return;
    setTestingN8n(true);
    try {
      const list = await api<N8nWorkflow[]>("/n8n/workflows");
      toast(`n8n connected: ${list.length} workflows`, "success");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setTestingN8n(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Text style={styles.title}>SETTINGS</Text>
      </View>
      <KeyboardAwareScrollView
        bottomOffset={spacing.xl}
        contentContainerStyle={[styles.content, { paddingBottom: bottomChrome + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
        testID="settings-scroll"
      >
        <SectionLabel>LLM Provider</SectionLabel>
        <View style={styles.card}>
          <Segmented
            testID="settings-provider"
            value={s.provider}
            onChange={(v) => set({ provider: v })}
            options={[
              { value: "emergent", label: "Cloud API" },
              { value: "local", label: "Local LLM" },
            ]}
          />
          {s.provider === "emergent" ? (
            <View style={{ marginTop: spacing.lg }}>
              <View style={styles.infoRow}>
                <Cloud size={18} color={colors.brandPrimary} />
                <Text style={styles.info}>Uses the Emergent Universal Key. No API key needed.</Text>
              </View>
              <Text style={styles.label}>PROVIDER</Text>
              <Chips
                testID="settings-cloud-provider"
                options={PROVIDERS.map((p) => p.label)}
                value={PROVIDERS.find((p) => p.key === s.emergent_provider)?.label ?? "OpenAI"}
                onChange={(label) => {
                  const key = PROVIDERS.find((p) => p.label === label)!.key;
                  set({ emergent_provider: key, emergent_model: MODELS[key][0] });
                }}
              />
              <Text style={styles.label}>MODEL</Text>
              <Chips
                testID="settings-cloud-model"
                options={MODELS[s.emergent_provider]}
                value={s.emergent_model}
                onChange={(m) => set({ emergent_model: m })}
              />
            </View>
          ) : (
            <View style={{ marginTop: spacing.lg }}>
              <View style={styles.infoRow}>
                <Cpu size={18} color={colors.brandPrimary} />
                <Text style={styles.info}>
                  Any OpenAI-compatible server (Ollama, LM Studio, vLLM). The URL must be reachable from the app server, e.g. via a tunnel like ngrok.
                </Text>
              </View>
              <Field
                label="Base URL"
                value={s.local_base_url}
                onChangeText={(v) => set({ local_base_url: v })}
                placeholder="https://my-ollama.ngrok.app/v1"
                keyboardType="url"
                testID="settings-local-url-input"
              />
              <Field
                label="Model"
                value={s.local_model}
                onChangeText={(v) => set({ local_model: v })}
                placeholder="llama3.2"
                testID="settings-local-model-input"
              />
              <Field
                label="API Key (optional)"
                value={s.local_api_key}
                onChangeText={(v) => set({ local_api_key: v })}
                placeholder="Leave empty for Ollama"
                secureTextEntry
                testID="settings-local-key-input"
              />
            </View>
          )}
          <Button title="Test connection" variant="secondary" onPress={testLlm} loading={testing} testID="settings-test-llm-button" />
          {testResult && (
            <Text style={[styles.testResult, { color: testResult.ok ? colors.success : colors.error }]} testID="settings-test-llm-result">
              {testResult.text}
            </Text>
          )}
        </View>

        <SectionLabel>n8n Connection (optional)</SectionLabel>
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Plugs size={18} color={colors.brandPrimary} />
            <Text style={styles.info}>Connect a self-hosted or cloud n8n to view and toggle its workflows. Create the key in n8n: Settings, n8n API.</Text>
          </View>
          <Field
            label="n8n URL"
            value={s.n8n_url}
            onChangeText={(v) => set({ n8n_url: v })}
            placeholder="https://n8n.mydomain.com"
            keyboardType="url"
            testID="settings-n8n-url-input"
          />
          <Field
            label="n8n API Key"
            value={s.n8n_api_key}
            onChangeText={(v) => set({ n8n_api_key: v })}
            placeholder="n8n_api_..."
            secureTextEntry
            testID="settings-n8n-key-input"
          />
          <Button title="Test n8n" variant="secondary" onPress={testN8n} loading={testingN8n} testID="settings-test-n8n-button" />
        </View>

        <Button title="Save configuration" onPress={() => save()} loading={saving} testID="settings-save-button" style={{ marginTop: spacing.sm }} />
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  center: { alignItems: "center", justifyContent: "center" },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: c.border },
  title: { color: c.onSurface, fontFamily: fonts.display, fontSize: 28, letterSpacing: 1.5 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  infoRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  info: { flex: 1, color: c.onSurfaceTertiary, fontFamily: fonts.body, fontSize: 13, lineHeight: 19 },
  label: {
    color: c.onSurfaceTertiary,
    fontFamily: fonts.displaySemi,
    fontSize: 13,
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  testResult: { fontFamily: fonts.mono, fontSize: 12, marginTop: spacing.md },
}));
