import { useLocalSearchParams, useRouter } from "expo-router";
import { CaretLeft } from "phosphor-react-native";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, Run } from "@/src/api";
import { RunLogs } from "@/src/components/run-logs";
import { useToast } from "@/src/components/toast";
import { Badge } from "@/src/components/ui";
import { executeDeviceActions } from "@/src/device";
import { fonts, makeStyles, spacing, useTheme } from "@/src/theme";

/** Deep link trigger: automata://run/<workflowId>?input=... (use from Android/iOS Shortcuts, Tasker, NFC tags). */
export default function DeepLinkRun() {
  const { id, input } = useLocalSearchParams<{ id: string; input?: string }>();
  const router = useRouter();
  const toast = useToast();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<Run>(`/workflows/${id}/run`, { method: "POST", body: { input: input ?? "", trigger: "app" } })
      .then(async (r) => {
        setRun(r);
        await executeDeviceActions(r.device_actions, toast);
      })
      .catch((e) => setError(e.message));
  }, [id, input, toast]);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={back} style={styles.iconBtn} testID="deeplink-back-button">
          <CaretLeft size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {run?.workflow_name ?? "RUNNING"}
        </Text>
        <View style={styles.iconBtn}>{run && <Badge status={run.status} testID="deeplink-run-status" />}</View>
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}>
        {error ? (
          <Text style={styles.err} testID="deeplink-error">{error}</Text>
        ) : run ? (
          <RunLogs run={run} />
        ) : (
          <ActivityIndicator color={colors.brandPrimary} />
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border },
  title: { flex: 1, textAlign: "center", color: c.onSurface, fontFamily: fonts.display, fontSize: 20 },
  iconBtn: { minWidth: 44, height: 44, alignItems: "center", justifyContent: "center" },
  content: { padding: spacing.lg },
  err: { color: c.error, fontFamily: fonts.medium },
}));
