import { Image } from "expo-image";
import { useFocusEffect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Clock, HandTap, Link, MagnifyingGlass, MapPin, Plus, TreeStructure } from "phosphor-react-native";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Switch, Text, TextInput, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, N8nWorkflow, Settings, timeAgo, Workflow } from "@/src/api";
import { useToast } from "@/src/components/toast";
import { Badge, Button, PressScale, Segmented } from "@/src/components/ui";
import { usesNativeTabs } from "@/src/navigation";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

const EMPTY_IMG =
  "https://images.unsplash.com/photo-1518770660439-4636190af475?crop=entropy&cs=srgb&fm=jpg&q=60&w=800";

export default function WorkflowsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const [mode, setMode] = useState<"local" | "n8n">("local");
  const [items, setItems] = useState<Workflow[]>([]);
  const [n8n, setN8n] = useState<N8nWorkflow[]>([]);
  const [n8nError, setN8nError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      setError(null);
      setItems(await api<Workflow[]>("/workflows"));
    } catch (e: any) {
      setError(e.message);
    }
    try {
      setN8nError(null);
      const s = await api<Settings>("/settings");
      if (!s.n8n_url || !s.n8n_api_key) throw new Error("n8n instance not configured");
      setN8n(await api<N8nWorkflow[]>("/n8n/workflows"));
    } catch (e: any) {
      setN8nError(e.message);
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const toggle = async (wf: Workflow, v: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    setItems((p) => p.map((w) => (w.id === wf.id ? { ...w, active: v } : w)));
    try {
      const upd = await api<Workflow>(`/workflows/${wf.id}/active`, { method: "POST", body: { active: v } });
      setItems((p) => p.map((w) => (w.id === wf.id ? upd : w)));
    } catch (e: any) {
      toast(e.message, "error");
      setItems((p) => p.map((w) => (w.id === wf.id ? { ...w, active: !v } : w)));
    }
  };

  const toggleN8n = async (wf: N8nWorkflow, v: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    try {
      await api(`/n8n/workflows/${wf.id}/active`, { method: "POST", body: { active: v } });
      setN8n((p) => p.map((w) => (w.id === wf.id ? { ...w, active: v } : w)));
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  const filtered = items.filter((w) => w.name.toLowerCase().includes(q.toLowerCase()));
  const triggerIcon = (t: string) =>
    t === "schedule" ? (
      <Clock size={18} color={colors.brandPrimary} />
    ) : t === "location" ? (
      <MapPin size={18} color={colors.brandPrimary} />
    ) : t === "webhook" ? (
      <Link size={18} color={colors.brandPrimary} />
    ) : (
      <HandTap size={18} color={colors.brandPrimary} />
    );

  const renderLocal = ({ item, index }: { item: Workflow; index: number }) => (
    <Animated.View entering={FadeInDown.delay(Math.min(index, 8) * 50)}>
      <PressScale style={styles.card} onPress={() => router.push(`/workflow/${item.id}`)} testID={`workflow-card-${item.id}`}>
        <View style={styles.cardTop}>
          <View style={styles.trigIcon}>{triggerIcon(item.trigger.type)}</View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.cardMeta} numberOfLines={1}>
              {`${item.trigger.type.toUpperCase()}${item.trigger.type === "schedule" ? ` / ${item.trigger.interval_minutes}m` : ""} · ${item.steps.length} steps`}
            </Text>
          </View>
          <Switch
            value={item.active}
            onValueChange={(v) => toggle(item, v)}
            trackColor={{ true: colors.brandPrimary, false: colors.surfaceTertiary }}
            thumbColor={colors.onSurface}
            testID={`workflow-toggle-${item.id}`}
          />
        </View>
        <View style={styles.cardBottom}>
          <Text style={styles.cardMeta}>{`Last: ${timeAgo(item.last_run_at)}`}</Text>
          {item.next_run_at && item.active ? <Text style={styles.cardMeta}>{`Next: ${timeAgo(item.next_run_at)}`}</Text> : null}
          <View style={{ flex: 1 }} />
          {item.last_status ? <Badge status={item.last_status} /> : null}
        </View>
      </PressScale>
    </Animated.View>
  );

  const renderN8n = ({ item }: { item: N8nWorkflow }) => (
    <View style={styles.card} testID={`n8n-workflow-${item.id}`}>
      <View style={styles.cardTop}>
        <View style={styles.trigIcon}>
          <TreeStructure size={18} color={colors.brandPrimary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.cardMeta}>{`${item.nodes} nodes · ${timeAgo(item.updated_at)}`}</Text>
        </View>
        <Switch
          value={item.active}
          onValueChange={(v) => toggleN8n(item, v)}
          trackColor={{ true: colors.brandPrimary, false: colors.surfaceTertiary }}
          thumbColor={colors.onSurface}
          testID={`n8n-toggle-${item.id}`}
        />
      </View>
    </View>
  );

  const emptyLocal = (
    <View style={styles.empty} testID="workflows-empty">
      <Image source={{ uri: EMPTY_IMG }} style={styles.emptyImg} contentFit="cover" />
      <Text style={styles.emptyTitle}>No workflows yet</Text>
      <Text style={styles.emptyText}>Build one with the editor, or ask the Agent to create it for you.</Text>
      <Button title="New workflow" onPress={() => router.push("/workflow/new")} testID="workflows-empty-create-button" />
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Text style={styles.title}>WORKFLOWS</Text>
        <Segmented
          testID="workflows-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "local", label: "Built-in" },
            { value: "n8n", label: "n8n Instance" },
          ]}
        />
        {mode === "local" && (
          <View style={styles.search}>
            <MagnifyingGlass size={18} color={colors.muted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search workflows"
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
              testID="workflows-search-input"
            />
          </View>
        )}
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : mode === "local" ? (
        error ? (
          <View style={styles.center}>
            <Text style={styles.errText} testID="workflows-error">{error}</Text>
            <Button title="Retry" variant="secondary" onPress={load} testID="workflows-retry-button" />
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(w) => w.id}
            renderItem={renderLocal}
            contentContainerStyle={[styles.list, { paddingBottom: bottomChrome + 96 }]}
            ListEmptyComponent={q ? <Text style={styles.emptyText}>No matches.</Text> : emptyLocal}
            refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.brandPrimary} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
            testID="workflows-list"
          />
        )
      ) : (
        <FlatList
          data={n8n}
          keyExtractor={(w) => w.id}
          renderItem={renderN8n}
          contentContainerStyle={[styles.list, { paddingBottom: bottomChrome + spacing.xl }]}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.brandPrimary} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
          ListEmptyComponent={
            <View style={styles.empty} testID="n8n-empty">
              <Text style={styles.emptyTitle}>{n8nError ? "Not connected" : "No n8n workflows"}</Text>
              <Text style={styles.emptyText}>
                {n8nError ?? "Your n8n instance has no workflows."}
                {n8nError ? "\nAdd your n8n URL and API key in Settings." : ""}
              </Text>
              <Button title="Open settings" variant="secondary" onPress={() => router.push("/settings")} testID="n8n-open-settings-button" />
            </View>
          }
        />
      )}
      {mode === "local" && (
        <Pressable
          style={[styles.fab, { bottom: bottomChrome + spacing.lg }]}
          onPress={() => router.push("/workflow/new")}
          testID="workflows-new-fab"
        >
          <Plus size={26} color={colors.onBrandPrimary} weight="bold" />
        </Pressable>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md, borderBottomWidth: 1, borderBottomColor: c.border },
  title: { color: c.onSurface, fontFamily: fonts.display, fontSize: 28, letterSpacing: 1.5 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: c.surfaceTertiary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  searchInput: { flex: 1, color: c.onSurface, fontFamily: fonts.body, fontSize: 15, height: 44 },
  list: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  errText: { color: c.error, fontFamily: fonts.body, textAlign: "center" },
  card: {
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  trigIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: c.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 19 },
  cardMeta: { color: c.muted, fontFamily: fonts.mono, fontSize: 11 },
  cardBottom: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  empty: { alignItems: "flex-start", gap: spacing.md, paddingTop: spacing.md },
  emptyImg: { width: "100%", height: 160, borderRadius: radius.lg, opacity: 0.7 },
  emptyTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 24 },
  emptyText: { color: c.onSurfaceTertiary, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  fab: {
    position: "absolute",
    right: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
}));
