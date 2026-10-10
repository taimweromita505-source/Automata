import { useRouter } from "expo-router";
import { CaretLeft, Key, Plus, Trash } from "phosphor-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, Credential } from "@/src/api";
import { useToast } from "@/src/components/toast";
import { Button, Chips, Field, Sheet } from "@/src/components/ui";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

const TYPES: Record<string, { label: string; fields: string[]; help: string }> = {
  telegram: {
    label: "Telegram",
    fields: ["bot_token", "chat_id"],
    help: "In Telegram, message @BotFather and send /newbot to get a token. Send your bot a message, then open api.telegram.org/bot<TOKEN>/getUpdates and copy message.chat.id.",
  },
  slack: { label: "Slack", fields: ["webhook_url"], help: "api.slack.com/apps → Create app → Incoming Webhooks → Add New Webhook → pick a channel → copy the URL." },
  discord: { label: "Discord", fields: ["webhook_url"], help: "Server Settings → Integrations → Webhooks → New Webhook → pick a channel → Copy Webhook URL." },
  resend: { label: "Email (Resend)", fields: ["api_key", "from"], help: "resend.com → API Keys → Create (Sending access). 'from' must use a domain you verified in Resend, e.g. bot@yourdomain.com." },
  google: {
    label: "Google",
    fields: ["client_id", "client_secret", "refresh_token"],
    help: "Google Cloud Console: enable the Sheets / Gmail / Drive / Calendar APIs, then create an OAuth client (Web) with redirect URI https://developers.google.com/oauthplayground. In OAuth Playground, click the gear, choose 'Use your own OAuth credentials', authorize the scopes you need, and exchange the code for a refresh token.",
  },
  bearer: { label: "Bearer token", fields: ["token"], help: "Sent as 'Authorization: Bearer <token>'. Works with GitHub, Notion, OpenAI, Airtable and most APIs." },
  api_key: { label: "API key header", fields: ["header", "value"], help: "Header name (e.g. X-API-Key) and its value, added to HTTP steps." },
  basic: { label: "Basic auth", fields: ["username", "password"], help: "Username and password for HTTP basic auth." },
  custom: { label: "Custom", fields: [], help: "Any fields you like. Use them in steps as {{cred.NAME.field}}. Add 'header' and 'value' fields to use it with HTTP steps." },
};
const TYPE_KEYS = Object.keys(TYPES);

export default function CredentialsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("telegram");
  const [name, setName] = useState("");
  const [data, setData] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState('{\n  "header": "X-API-Key",\n  "value": ""\n}');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api<Credential[]>("/credentials"));
    } catch (e: any) {
      toast(e.message, "error");
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setError(null);
    let payload = data;
    if (type === "custom") {
      try {
        payload = JSON.parse(custom);
      } catch {
        setError("Custom fields must be valid JSON");
        return;
      }
    }
    setSaving(true);
    try {
      await api("/credentials", { method: "POST", body: { name: name || type, type, data: payload } });
      toast("Credential saved securely", "success");
      setOpen(false);
      setName("");
      setData({});
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Credential) => {
    await api(`/credentials/${c.id}`, { method: "DELETE" }).catch(() => {});
    setItems((p) => p.filter((x) => x.id !== c.id));
    toast("Credential deleted", "success");
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn} testID="credentials-back-button">
          <CaretLeft size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>CREDENTIALS</Text>
        <Pressable onPress={() => { setError(null); setOpen(true); }} style={styles.iconBtn} testID="credentials-add-button">
          <Plus size={24} color={colors.brandPrimary} weight="bold" />
        </Pressable>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(c) => c.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.xl }]}
          ListHeaderComponent={
            <Text style={styles.intro}>
              Your own keys for Telegram, Slack, Google and any API. Encrypted on the server and only used by your workflows and agent.
            </Text>
          }
          ListEmptyComponent={
            <View style={styles.empty} testID="credentials-empty">
              <Key size={36} color={colors.brandPrimary} weight="duotone" />
              <Text style={styles.emptyTitle}>No credentials yet</Text>
              <Button title="Add credential" onPress={() => { setError(null); setOpen(true); }} testID="credentials-empty-add-button" />
            </View>
          }
          renderItem={({ item, index }) => (
            <Animated.View entering={FadeInDown.delay(index * 40)} style={styles.card} testID={`credential-card-${item.name}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>{`${TYPES[item.type]?.label ?? item.type} · ${Object.keys(item.fields).join(", ")}`}</Text>
              </View>
              <Pressable onPress={() => remove(item)} style={styles.iconBtn} testID={`credential-delete-${item.name}`}>
                <Trash size={20} color={colors.error} />
              </Pressable>
            </Animated.View>
          )}
        />
      )}
      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Add credential"
        testID="credential-sheet"
        footer={<Button title="Save credential" onPress={save} loading={saving} testID="credential-save-button" />}
      >
        <Text style={styles.label}>TYPE</Text>
        <Chips
          testID="credential-type"
          options={TYPE_KEYS.map((k) => TYPES[k].label)}
          value={TYPES[type].label}
          onChange={(l) => {
            setType(TYPE_KEYS.find((k) => TYPES[k].label === l)!);
            setData({});
            setError(null);
          }}
        />
        <View style={styles.help}>
          <Text style={styles.helpText}>{TYPES[type].help}</Text>
        </View>
        {error && <Text style={styles.err} testID="credential-error">{error}</Text>}
        <Field label="Name" value={name} onChangeText={setName} placeholder={`my_${type}`} testID="credential-name-input" hint="Letters, numbers and _ only. Used in steps." />
        {type === "custom" ? (
          <Field label="Fields (JSON)" value={custom} onChangeText={setCustom} multiline testID="credential-custom-input" />
        ) : (
          TYPES[type].fields.map((f) => (
            <Field
              key={f}
              label={f.replace(/_/g, " ")}
              value={data[f] ?? ""}
              onChangeText={(v) => setData({ ...data, [f]: v })}
              secureTextEntry={/token|key|secret|password/.test(f)}
              testID={`credential-field-${f}`}
            />
          ))
        )}
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border },
  title: { flex: 1, textAlign: "center", color: c.onSurface, fontFamily: fonts.display, fontSize: 22, letterSpacing: 1.2 },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },
  intro: { color: c.onSurfaceTertiary, fontFamily: fonts.body, fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
  empty: { alignItems: "flex-start", gap: spacing.md, paddingTop: spacing.lg },
  emptyTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 24 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
  },
  name: { color: c.onSurface, fontFamily: fonts.display, fontSize: 18 },
  meta: { color: c.muted, fontFamily: fonts.mono, fontSize: 11 },
  label: { color: c.onSurfaceTertiary, fontFamily: fonts.displaySemi, fontSize: 13, letterSpacing: 1, marginBottom: spacing.sm },
  help: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.lg },
  helpText: { color: c.onSurfaceTertiary, fontFamily: fonts.body, fontSize: 13, lineHeight: 19 },
  err: { color: c.error, fontFamily: fonts.medium, marginBottom: spacing.md },
}));
