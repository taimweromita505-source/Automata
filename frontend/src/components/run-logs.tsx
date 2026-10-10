import React from "react";
import { Text, View } from "react-native";

import { Run } from "@/src/api";
import { Badge } from "@/src/components/ui";
import { fonts, makeStyles, radius, spacing } from "@/src/theme";

export function RunLogs({ run }: { run: Run }) {
  const styles = useStyles();
  return (
    <View style={styles.console} testID={`run-logs-${run.id}`}>
      {run.input ? <Text style={styles.line}>{`> input: ${run.input.slice(0, 300)}`}</Text> : null}
      {run.logs.length === 0 && <Text style={styles.line}>{"> no steps executed"}</Text>}
      {run.logs.map((l, i) => (
        <View key={`${l.step_id}-${i}`} style={styles.step}>
          <View style={styles.stepHead}>
            <Text style={styles.stepName} numberOfLines={1}>{`[${i + 1}] ${l.name}`}</Text>
            <Text style={styles.dur}>{`${l.duration_ms}ms`}</Text>
            <Badge status={l.status} />
          </View>
          {l.error ? (
            <Text style={[styles.line, styles.err]}>{`! ${l.error}`}</Text>
          ) : (
            <Text style={styles.line} selectable>
              {l.output.slice(0, 1200) || "(empty)"}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  console: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  step: { gap: spacing.xs },
  stepHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  stepName: { flex: 1, color: c.onSurface, fontFamily: fonts.mono, fontSize: 12 },
  dur: { color: c.muted, fontFamily: fonts.mono, fontSize: 11 },
  line: { color: c.onSurfaceTertiary, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  err: { color: c.error },
}));
