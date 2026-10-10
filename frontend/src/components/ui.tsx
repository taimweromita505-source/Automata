import React from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewStyle,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "phosphor-react-native";

import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function PressScale({
  children,
  style,
  onPress,
  disabled,
  testID,
}: {
  children: React.ReactNode;
  style?: any;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const s = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <AnimatedPressable
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => (s.value = withTiming(0.97, { duration: 80 }))}
      onPressOut={() => (s.value = withTiming(1, { duration: 120 }))}
      style={[style, a, disabled && { opacity: 0.5 }]}
    >
      {children}
    </AnimatedPressable>
  );
}

export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  icon,
  testID,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  testID?: string;
  style?: ViewStyle;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const fg =
    variant === "primary" ? colors.onBrandPrimary : variant === "danger" ? colors.error : colors.onSurface;
  return (
    <PressScale
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      style={[styles.btn, styles[`btn_${variant}`], style]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon}
      <Text style={[styles.btnText, { color: fg }]}>{title}</Text>
    </PressScale>
  );
}

export function Badge({ status, testID }: { status: string; testID?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const map: Record<string, [string, string]> = {
    success: [colors.success, colors.onSuccess],
    failed: [colors.error, colors.onError],
    running: [colors.warning, colors.onWarning],
    stopped: [colors.surfaceTertiary, colors.onSurfaceTertiary],
  };
  const [bg, fg] = map[status] ?? [colors.surfaceTertiary, colors.onSurfaceTertiary];
  return (
    <View testID={testID} style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={[styles.input, props.multiline && styles.inputMulti, props.style]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.seg} testID={testID}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          testID={`${testID}-${o.value}`}
          onPress={() => onChange(o.value)}
          style={[styles.segItem, value === o.value && styles.segItemActive]}
        >
          <Text style={[styles.segText, value === o.value && styles.segTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Chips({
  options,
  value,
  onChange,
  testID,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRow}
      style={styles.chipScroll}
    >
      {options.map((o) => (
        <Pressable
          key={o}
          testID={`${testID}-${o}`}
          onPress={() => onChange(o)}
          style={[styles.chip, value === o && styles.chipActive]}
        >
          <Text style={[styles.chipText, value === o && styles.chipTextActive]}>{o}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  footer,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={styles.sheetWrap}>
        <Pressable style={styles.backdrop} onPress={onClose} testID={`${testID}-backdrop`} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg, maxHeight: "88%" }]} testID={testID}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} style={styles.iconBtn} testID={`${testID}-close`}>
              <X size={20} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.lg }}>
            {children}
          </ScrollView>
          {footer}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.section}>{children}</Text>;
}

export const useStyles = makeStyles((c) => ({
  btn: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  btn_primary: { backgroundColor: c.brandPrimary },
  btn_secondary: { backgroundColor: c.surfaceTertiary, borderWidth: 1, borderColor: c.border },
  btn_ghost: { backgroundColor: "transparent", borderWidth: 1, borderColor: c.border },
  btn_danger: { backgroundColor: "transparent", borderWidth: 1, borderColor: c.error },
  btnText: { fontFamily: fonts.display, fontSize: 17, letterSpacing: 0.6, textTransform: "uppercase" },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  badgeText: { fontFamily: fonts.display, fontSize: 12, letterSpacing: 0.8 },
  field: { marginBottom: spacing.lg },
  label: {
    color: c.onSurfaceTertiary,
    fontFamily: fonts.displaySemi,
    fontSize: 13,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: c.surfaceTertiary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    color: c.onSurface,
    fontFamily: fonts.body,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 48,
  },
  inputMulti: { minHeight: 96, textAlignVertical: "top" },
  hint: { color: c.muted, fontFamily: fonts.body, fontSize: 12, marginTop: spacing.xs },
  seg: {
    flexDirection: "row",
    backgroundColor: c.surfaceSecondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: 3,
  },
  segItem: { flex: 1, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segItemActive: { backgroundColor: c.brandPrimary },
  segText: { color: c.onSurfaceTertiary, fontFamily: fonts.displaySemi, fontSize: 15, letterSpacing: 0.5 },
  segTextActive: { color: c.onBrandPrimary },
  chipScroll: { flexGrow: 0, marginBottom: spacing.lg },
  chipRow: { gap: spacing.sm },
  chip: {
    flexShrink: 0,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceSecondary,
    justifyContent: "center",
  },
  chipActive: { borderColor: c.brandPrimary, backgroundColor: c.brandTertiary },
  chipText: { color: c.onSurfaceSecondary, fontFamily: fonts.medium, fontSize: 13 },
  chipTextActive: { color: c.onBrandTertiary },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const), backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    backgroundColor: c.surfaceSecondary,
    borderTopLeftRadius: radius.lg * 2,
    borderTopRightRadius: radius.lg * 2,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  sheetTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 22, letterSpacing: 0.5 },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  section: {
    color: c.brandPrimary,
    fontFamily: fonts.display,
    fontSize: 14,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
}));
