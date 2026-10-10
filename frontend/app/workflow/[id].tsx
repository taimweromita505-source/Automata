import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CaretLeft,
  Clock,
  Funnel,
  Globe,
  HandTap,
  Link,
  PencilSimple,
  Play,
  Plus,
  TextT,
  Timer,
  Trash,
} from "phosphor-react-native";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, { FadeInDown, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, BASE, Run, Step, STEP_META, StepType, Trigger, Workflow } from "@/src/api";
import { RunLogs } from "@/src/components/run-logs";
import { useToast } from "@/src/components/toast";
import { Badge, Button, Chips, Field, PressScale, Segmented, Sheet } from "@/src/components/ui";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Draft = Omit<Workflow, "id"> & { id?: string };

const EMPTY: Draft = {
  name: "",
  description: "",
  active: false,
  trigger: { type: "manual", interval_minutes: 60 },
  steps: [],
};

const DEFAULT_CONFIG: Record<StepType, Record<string, any>> = {
  http: { method: "GET", url: "", headers: "", body: "" },
  llm: { prompt: "Summarize this:\n{{prev}}", system: "" },
  delay: { seconds: 5 },
  set: { value: "{{prev}}" },
  filter: { contains: "" },
};

function StepIcon({ type, color }: { type: StepType; color: string }) {
  const p = { size: 20, color };
  if (type === "http") return <Globe {...p} />;
  if (type === "llm") return <Brain {...p} />;
  if (type === "delay") return <Timer {...p} />;
  if (type === "filter") return <Funnel {...p} />;
  return <TextT {...p} />;
}

function stepSummary(s: Step) {
  const c = s.config;
  if (s.type === "http") return `${c.method ?? "GET"} ${c.url || "(no url)"}`;
  if (s.type === "llm") return c.prompt || "(no prompt)";
  if (s.type === "delay") return `Wait ${c.seconds ?? 0}s`;
  if (s.type === "filter") return `Continue if contains "${c.contains ?? ""}"`;
  return c.value || "(empty)";
}

export default function WorkflowEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const router = useRouter();
  const toast = useToast();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [wf, setWf] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editStep, setEditStep] = useState<Step | null>(null);
  const [triggerSheet, setTriggerSheet] = useState(false);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [runInput, setRunInput] = useState("");
  const [runSheet, setRunSheet] = useState(false);

  useEffect(() => {
    if (isNew) return;
    api<Workflow>(`/workflows/${id}`)
      .then(setWf)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  const payload = () => ({
    name: wf.name.trim(),
    description: wf.description,
    active: wf.active,
    trigger: wf.trigger,
    steps: wf.steps,
  });

  const save = async (): Promise<string | null> => {
    if (!wf.name.trim()) {
      setError("Give your workflow a name");
      return null;
    }
    if (wf.steps.length === 0) {
      setError("Add at least one step");
      return null;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = isNew || !wf.id
        ? await api<Workflow>("/workflows", { method: "POST", body: payload() })
        : await api<Workflow>(`/workflows/${wf.id}`, { method: "PUT", body: payload() });
      setWf(saved);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      toast("Workflow saved", "success");
      if (isNew) router.replace(`/workflow/${saved.id}`);
      return saved.id;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    const wid = await save();
    if (!wid) return;
    setRunning(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    try {
      const r = await api<Run>(`/workflows/${wid}/run`, { method: "POST", body: { input: runInput } });
      setLastRun(r);
      setRunSheet(true);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    if (!wf.id) return router.back();
    await api(`/workflows/${wf.id}`, { method: "DELETE" }).catch(() => {});
    toast("Workflow deleted", "success");
    router.back();
  };

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= wf.steps.length) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    const steps = [...wf.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setWf({ ...wf, steps });
  };

  const addStep = (type: StepType) => {
    const step: Step = { id: Math.random().toString(36).slice(2, 10), type, name: STEP_META[type].label, config: { ...DEFAULT_CONFIG[type] } };
    setPicker(false);
    setWf({ ...wf, steps: [...wf.steps, step] });
    setTimeout(() => {
      setEditIdx(wf.steps.length);
      setEditStep(step);
    }, 350);
  };

  const commitStep = () => {
    if (editIdx === null || !editStep) return;
    const steps = [...wf.steps];
    steps[editIdx] = editStep;
    setWf({ ...wf, steps });
    setEditIdx(null);
    setEditStep(null);
  };

  const deleteStep = () => {
    if (editIdx === null) return;
    setWf({ ...wf, steps: wf.steps.filter((_, i) => i !== editIdx) });
    setEditIdx(null);
    setEditStep(null);
  };

  const setTrigger = (t: Partial<Trigger>) => setWf({ ...wf, trigger: { ...wf.trigger, ...t } });
  const cfg = (patch: Record<string, any>) => editStep && setEditStep({ ...editStep, config: { ...editStep.config, ...patch } });

  if (loading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }

  const trig = wf.trigger;
  const TrigIcon = trig.type === "schedule" ? Clock : trig.type === "webhook" ? Link : HandTap;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn} testID="editor-back-button">
          <CaretLeft size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {isNew ? "NEW WORKFLOW" : "EDIT WORKFLOW"}
        </Text>
        <Pressable onPress={remove} style={styles.iconBtn} testID="editor-delete-button">
          <Trash size={22} color={colors.error} />
        </Pressable>
      </View>

      <KeyboardAwareScrollView
        bottomOffset={120}
        contentContainerStyle={[styles.content, { paddingBottom: 140 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        testID="editor-scroll"
      >
        {error && (
          <View style={styles.errBanner} testID="editor-error-banner">
            <Text style={styles.errText}>{error}</Text>
          </View>
        )}
        <Field label="Name" value={wf.name} onChangeText={(v) => setWf({ ...wf, name: v })} placeholder="Daily news digest" autoCapitalize="sentences" testID="editor-name-input" />
        <Field label="Description" value={wf.description} onChangeText={(v) => setWf({ ...wf, description: v })} placeholder="What does it do?" autoCapitalize="sentences" testID="editor-description-input" />
        <View style={styles.activeRow}>
          <Text style={styles.activeLabel}>ACTIVE</Text>
          <Switch
            value={wf.active}
            onValueChange={(v) => setWf({ ...wf, active: v })}
            trackColor={{ true: colors.brandPrimary, false: colors.surfaceTertiary }}
            thumbColor={colors.onSurface}
            testID="editor-active-switch"
          />
        </View>

        {/* Node chain */}
        <PressScale style={[styles.node, styles.triggerNode]} onPress={() => setTriggerSheet(true)} testID="editor-trigger-node">
          <View style={[styles.nodeIcon, { backgroundColor: colors.brandPrimary }]}>
            <TrigIcon size={20} color={colors.onBrandPrimary} weight="bold" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.nodeKind}>TRIGGER</Text>
            <Text style={styles.nodeTitle}>
              {trig.type === "manual" ? "Manual run" : trig.type === "schedule" ? `Every ${trig.interval_minutes} min` : "Webhook"}
            </Text>
          </View>
          <PencilSimple size={18} color={colors.muted} />
        </PressScale>

        {wf.steps.map((s, i) => (
          <Animated.View key={s.id} entering={FadeInDown} layout={LinearTransition}>
            <View style={styles.connector} />
            <PressScale
              style={styles.node}
              onPress={() => {
                setEditIdx(i);
                setEditStep({ ...s, config: { ...s.config } });
              }}
              testID={`editor-step-node-${i}`}
            >
              <View style={styles.nodeIcon}>
                <StepIcon type={s.type} color={colors.brandPrimary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.nodeKind}>{`${i + 1} · ${STEP_META[s.type].label.toUpperCase()}`}</Text>
                <Text style={styles.nodeTitle} numberOfLines={1}>
                  {s.name}
                </Text>
                <Text style={styles.nodeSummary} numberOfLines={2}>
                  {stepSummary(s)}
                </Text>
              </View>
              <View style={styles.moveCol}>
                <Pressable onPress={() => move(i, -1)} hitSlop={6} style={styles.moveBtn} testID={`editor-step-up-${i}`}>
                  <ArrowUp size={16} color={i === 0 ? colors.border : colors.onSurfaceTertiary} />
                </Pressable>
                <Pressable onPress={() => move(i, 1)} hitSlop={6} style={styles.moveBtn} testID={`editor-step-down-${i}`}>
                  <ArrowDown size={16} color={i === wf.steps.length - 1 ? colors.border : colors.onSurfaceTertiary} />
                </Pressable>
              </View>
            </PressScale>
          </Animated.View>
        ))}

        <View style={styles.connector} />
        <Pressable style={styles.addBtn} onPress={() => setPicker(true)} testID="editor-add-step-button">
          <Plus size={20} color={colors.brandPrimary} weight="bold" />
          <Text style={styles.addText}>ADD STEP</Text>
        </Pressable>

        <View style={{ marginTop: spacing.xl }}>
          <Field
            label="Test input (optional)"
            value={runInput}
            onChangeText={setRunInput}
            placeholder="Available as {{input}}"
            testID="editor-run-input"
          />
        </View>
      </KeyboardAwareScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Button title="Save" variant="secondary" onPress={save} loading={saving} style={{ flex: 1 }} testID="editor-save-button" />
        <Button
          title="Run"
          onPress={run}
          loading={running}
          style={{ flex: 1 }}
          icon={<Play size={18} color={colors.onBrandPrimary} weight="fill" />}
          testID="editor-run-button"
        />
      </View>

      {/* Step type picker */}
      <Sheet visible={picker} onClose={() => setPicker(false)} title="Add a step" testID="step-picker-sheet">
        {(Object.keys(STEP_META) as StepType[]).map((t) => (
          <Pressable key={t} style={styles.pickRow} onPress={() => addStep(t)} testID={`step-picker-${t}`}>
            <View style={styles.nodeIcon}>
              <StepIcon type={t} color={colors.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.nodeTitle}>{STEP_META[t].label}</Text>
              <Text style={styles.nodeSummary}>{STEP_META[t].hint}</Text>
            </View>
          </Pressable>
        ))}
      </Sheet>

      {/* Trigger config */}
      <Sheet
        visible={triggerSheet}
        onClose={() => setTriggerSheet(false)}
        title="Trigger"
        testID="trigger-sheet"
        footer={<Button title="Done" onPress={() => setTriggerSheet(false)} testID="trigger-done-button" />}
      >
        <Segmented
          testID="trigger-type"
          value={trig.type}
          onChange={(v) => setTrigger({ type: v })}
          options={[
            { value: "manual", label: "Manual" },
            { value: "schedule", label: "Schedule" },
            { value: "webhook", label: "Webhook" },
          ]}
        />
        <View style={{ height: spacing.lg }} />
        {trig.type === "schedule" && (
          <>
            <Text style={styles.sheetLabel}>INTERVAL</Text>
            <Chips
              testID="trigger-interval"
              options={["5", "15", "60", "360", "1440"]}
              value={String(trig.interval_minutes)}
              onChange={(v) => setTrigger({ interval_minutes: Number(v) })}
            />
            <Field
              label="Custom minutes"
              value={String(trig.interval_minutes)}
              onChangeText={(v) => setTrigger({ interval_minutes: Math.max(1, parseInt(v || "1", 10) || 1) })}
              keyboardType="number-pad"
              testID="trigger-minutes-input"
              hint="Runs while the workflow is Active. 1440 = daily."
            />
          </>
        )}
        {trig.type === "webhook" && (
          <View style={styles.hookBox} testID="trigger-webhook-url">
            <Text style={styles.sheetLabel}>POST TO THIS URL</Text>
            <Text style={styles.mono} selectable>
              {wf.id ? `${BASE}/api/hooks/${wf.id}` : "Save the workflow to get its webhook URL"}
            </Text>
            <Text style={styles.nodeSummary}>Request body becomes {"{{input}}"}. Workflow must be Active.</Text>
          </View>
        )}
        {trig.type === "manual" && <Text style={styles.nodeSummary}>Run from the editor or ask the Agent to run it.</Text>}
      </Sheet>

      {/* Step config */}
      <Sheet
        visible={!!editStep}
        onClose={commitStep}
        title={editStep ? STEP_META[editStep.type].label : ""}
        testID="step-config-sheet"
        footer={
          <View style={styles.sheetFooter}>
            <Button title="Delete" variant="danger" onPress={deleteStep} style={{ flex: 1 }} testID="step-config-delete-button" />
            <Button title="Apply" onPress={commitStep} style={{ flex: 2 }} testID="step-config-apply-button" />
          </View>
        }
      >
        {editStep && (
          <>
            <Field label="Step name" value={editStep.name} onChangeText={(v) => setEditStep({ ...editStep, name: v })} autoCapitalize="sentences" testID="step-name-input" />
            {editStep.type === "http" && (
              <>
                <Text style={styles.sheetLabel}>METHOD</Text>
                <Chips testID="step-http-method" options={["GET", "POST", "PUT", "DELETE"]} value={editStep.config.method} onChange={(v) => cfg({ method: v })} />
                <Field label="URL" value={editStep.config.url} onChangeText={(v) => cfg({ url: v })} placeholder="https://api.example.com/data" keyboardType="url" testID="step-http-url-input" />
                <Field label="Headers (JSON)" value={editStep.config.headers} onChangeText={(v) => cfg({ headers: v })} placeholder='{"Authorization": "Bearer ..."}' testID="step-http-headers-input" />
                <Field label="Body" value={editStep.config.body} onChangeText={(v) => cfg({ body: v })} placeholder='{"text": "{{prev}}"}' multiline testID="step-http-body-input" />
              </>
            )}
            {editStep.type === "llm" && (
              <>
                <Field label="Prompt" value={editStep.config.prompt} onChangeText={(v) => cfg({ prompt: v })} multiline autoCapitalize="sentences" testID="step-llm-prompt-input" />
                <Field label="System instructions (optional)" value={editStep.config.system} onChangeText={(v) => cfg({ system: v })} multiline autoCapitalize="sentences" testID="step-llm-system-input" />
              </>
            )}
            {editStep.type === "delay" && (
              <Field
                label="Seconds (max 60)"
                value={String(editStep.config.seconds ?? 0)}
                onChangeText={(v) => cfg({ seconds: Math.min(60, parseInt(v || "0", 10) || 0) })}
                keyboardType="number-pad"
                testID="step-delay-seconds-input"
              />
            )}
            {editStep.type === "set" && (
              <Field label="Value" value={editStep.config.value} onChangeText={(v) => cfg({ value: v })} multiline testID="step-set-value-input" />
            )}
            {editStep.type === "filter" && (
              <Field label="Continue only if output contains" value={editStep.config.contains} onChangeText={(v) => cfg({ contains: v })} testID="step-filter-contains-input" />
            )}
            <Text style={styles.nodeSummary}>{"Templates: {{input}} {{prev}} {{step_1}} {{now}}"}</Text>
          </>
        )}
      </Sheet>

      {/* Run result */}
      <Sheet visible={runSheet} onClose={() => setRunSheet(false)} title="Run result" testID="run-result-sheet">
        {lastRun && (
          <View style={{ gap: spacing.md }}>
            <View style={styles.activeRow}>
              <Text style={styles.activeLabel}>STATUS</Text>
              <Badge status={lastRun.status} testID="run-result-status" />
            </View>
            <RunLogs run={lastRun} />
          </View>
        )}
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerTitle: { flex: 1, color: c.onSurface, fontFamily: fonts.display, fontSize: 22, letterSpacing: 1.2, textAlign: "center" },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  content: { padding: spacing.lg },
  errBanner: { backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.error, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.lg },
  errText: { color: c.error, fontFamily: fonts.medium, fontSize: 14 },
  activeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.lg },
  activeLabel: { color: c.onSurfaceTertiary, fontFamily: fonts.displaySemi, fontSize: 13, letterSpacing: 1 },
  node: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  triggerNode: { borderColor: c.brandPrimary },
  nodeIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: c.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  nodeKind: { color: c.brandPrimary, fontFamily: fonts.displaySemi, fontSize: 12, letterSpacing: 1 },
  nodeTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 18 },
  nodeSummary: { color: c.muted, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
  connector: { width: 2, height: 24, backgroundColor: c.borderStrong, alignSelf: "center" },
  moveCol: { gap: spacing.xs },
  moveBtn: { width: 32, height: 28, alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceTertiary, borderRadius: radius.sm },
  addBtn: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: c.brandPrimary,
  },
  addText: { color: c.brandPrimary, fontFamily: fonts.display, fontSize: 15, letterSpacing: 1 },
  footer: {
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surface,
  },
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: spacing.sm,
    backgroundColor: c.surface,
  },
  sheetLabel: { color: c.onSurfaceTertiary, fontFamily: fonts.displaySemi, fontSize: 13, letterSpacing: 1, marginBottom: spacing.sm },
  sheetFooter: { flexDirection: "row", gap: spacing.md },
  hookBox: { gap: spacing.sm, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.md },
  mono: { color: c.onBrandTertiary, fontFamily: fonts.mono, fontSize: 12 },
}));
