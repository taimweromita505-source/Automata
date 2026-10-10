import { useFocusEffect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { Bell, CaretRight, Cloud, Cpu, Key, MapPin, Plugs } from "phosphor-react-native";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, MODELS, N8nWorkflow, Settings } from "@/src/api";
import { PermissionSheet } from "@/src/components/permission-sheet";
import { useToast } from "@/src/components/toast";
import { Button, Chips, Field, SectionLabel, Segmented } from "@/src/components/ui";
import { getNotificationPermission, requestNotificationPermission } from "@/src/device";
import { syncGeofences } from "@/src/geofence";
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
  const router = useRouter();
  const [notifStatus, setNotifStatus] = useState<"granted" | "denied" | "blocked" | "undetermined" | "unavailable">("undetermined");
  const [locStatus, setLocStatus] = useState<string>("off");
  const [permSheet, setPermSheet] = useState<null | "notifications" | "location">(null);
  const [locBlocked, setLocBlocked] = useState(false);

  const refreshPerms = useCallback(async () => {
    if (Platform.OS === "web") {
      setNotifStatus("unavailable");
      setLocStatus("unavailable");
      return;
    }
    const n = await getNotificationPermission();
    setNotifStatus(n.granted ? "granted" : n.canAskAgain ? (n.status === "undetermined" ? "undetermined" : "denied") : "blocked");
    const bg = await Location.getBackgroundPermissionsAsync();
    setLocStatus(bg.granted ? "on" : "off");
    setLocBlocked(!bg.granted && !bg.canAskAgain && bg.status !== "undetermined");
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshPerms();
    }, [refreshPerms]),
  );

  const allowNotifications = async () => {
    setPermSheet(null);
    const r = await requestNotificationPermission();
    await refreshPerms();
    toast(r.granted ? "Notifications enabled" : "Notifications not allowed", r.granted ? "success" : "error");
  };

  const allowLocation = async () => {
    setPermSheet(null);
    try {
      let fg = await Location.getForegroundPermissionsAsync();
      if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) {
        toast("Location not allowed", "error");
        return refreshPerms();
      }
      let bg = await Location.getBackgroundPermissionsAsync();
      if (!bg.granted && bg.canAskAgain) bg = await Location.requestBackgroundPermissionsAsync();
      await refreshPerms();
      if (!bg.granted) {
        toast("Choose 'Allow all the time' to run place triggers", "error");
        return;
      }
      const res = await syncGeofences();
      toast(res.ok ? `Location triggers on (${res.count} place${res.count === 1 ? "" : "s"})` : res.reason ?? "Failed", res.ok ? "success" : "error");
    } catch {
      toast("Location triggers need the installed app build", "error");
    }
  };

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

        <SectionLabel>Connections</SectionLabel>
        <Pressable style={[styles.card, styles.linkRow]} onPress={() => router.push("/credentials")} testID="settings-credentials-link">
          <Key size={20} color={colors.brandPrimary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Credentials vault</Text>
            <Text style={styles.info}>Your own keys: Telegram, Slack, Discord, Email, Google, any API</Text>
          </View>
          <CaretRight size={18} color={colors.muted} />
        </Pressable>

        <SectionLabel>Phone automations</SectionLabel>
        <View style={styles.card}>
          <View style={styles.permRow}>
            <Bell size={20} color={colors.brandPrimary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Notifications</Text>
              <Text style={styles.info} testID="settings-notifications-status">{`Status: ${notifStatus}`}</Text>
            </View>
            {notifStatus !== "granted" && notifStatus !== "unavailable" && (
              <Button title="Enable" variant="secondary" onPress={() => setPermSheet("notifications")} testID="settings-enable-notifications-button" />
            )}
          </View>
          <View style={[styles.permRow, { marginTop: spacing.lg }]}>
            <MapPin size={20} color={colors.brandPrimary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>Place triggers</Text>
              <Text style={styles.info} testID="settings-location-status">{`Background location: ${locStatus}`}</Text>
            </View>
            {locStatus !== "unavailable" && (
              <Button title={locStatus === "on" ? "Sync" : "Enable"} variant="secondary" onPress={() => (locStatus === "on" ? allowLocation() : setPermSheet("location"))} testID="settings-enable-location-button" />
            )}
          </View>
          <Text style={[styles.info, { marginTop: spacing.lg }]}>
            Phone actions and place triggers work in the installed app (APK). Expo Go and the web preview have limited support. Android may delay background events to save battery.
          </Text>
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
      <PermissionSheet
        visible={permSheet === "notifications"}
        title="Allow notifications"
        benefit="Your workflows can alert you the moment something happens: a price drop, a new email, a finished report."
        blocked={notifStatus === "blocked"}
        onAllow={allowNotifications}
        onClose={() => setPermSheet(null)}
        testID="notifications-permission-sheet"
      />
      <PermissionSheet
        visible={permSheet === "location"}
        title="Allow place triggers"
        benefit="Run automations when you arrive at or leave a place, like home or work. Choose 'Allow all the time' so it works when the app is closed. Your location is only checked by your phone."
        blocked={locBlocked}
        onAllow={allowLocation}
        onClose={() => setPermSheet(null)}
        testID="location-permission-sheet"
      />
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
  linkRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  permRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 17 },
}));
