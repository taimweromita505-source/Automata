import { useFocusEffect } from "expo-router";
import { CaretDown, CaretRight, Trash } from "phosphor-react-native";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, Run, timeAgo } from "@/src/api";
import { RunLogs } from "@/src/components/run-logs";
import { useToast } from "@/src/components/toast";
import { Badge, Button } from "@/src/components/ui";
import { usesNativeTabs } from "@/src/navigation";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function RunsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setRuns(await api<Run[]>("/runs?limit=100"));
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const clear = async () => {
    await api("/runs", { method: "DELETE" }).catch(() => {});
    setRuns([]);
    toast("Run history cleared", "success");
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>RUNS</Text>
          <Text style={styles.sub}>{`${runs.length} executions · ${runs.filter((r) => r.status === "failed").length} failed`}</Text>
        </View>
        <Pressable onPress={clear} style={styles.iconBtn} testID="runs-clear-button" hitSlop={8}>
          <Trash size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.err} testID="runs-error">{error}</Text>
          <Button title="Retry" variant="secondary" onPress={load} testID="runs-retry-button" />
        </View>
      ) : (
        <FlatList
          data={runs}
          keyExtractor={(r) => r.id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomChrome + spacing.xl }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.brandPrimary}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          ListEmptyComponent={
            <View style={styles.center} testID="runs-empty">
              <Text style={styles.emptyTitle}>No runs yet</Text>
              <Text style={styles.sub}>Run a workflow or let a schedule fire.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const isOpen = open === item.id;
            return (
              <View style={styles.row}>
                <Pressable style={styles.rowHead} onPress={() => setOpen(isOpen ? null : item.id)} testID={`run-row-${item.id}`}>
                  {isOpen ? <CaretDown size={16} color={colors.muted} /> : <CaretRight size={16} color={colors.muted} />}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {item.workflow_name}
                    </Text>
                    <Text style={styles.meta}>{`${item.trigger.toUpperCase()} · ${timeAgo(item.started_at)} · ${item.logs.length} steps`}</Text>
                  </View>
                  <Badge status={item.status} testID={`run-status-${item.id}`} />
                </Pressable>
                {isOpen && (
                  <Animated.View entering={FadeIn} style={{ marginTop: spacing.md }}>
                    <RunLogs run={item} />
                  </Animated.View>
                )}
              </View>
            );
          }}
        />
      )}
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
  sub: { color: c.muted, fontFamily: fonts.mono, fontSize: 12 },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  list: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  err: { color: c.error, fontFamily: fonts.body },
  emptyTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 24 },
  row: {
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 44 },
  name: { color: c.onSurface, fontFamily: fonts.display, fontSize: 18 },
  meta: { color: c.muted, fontFamily: fonts.mono, fontSize: 11 },
}));
