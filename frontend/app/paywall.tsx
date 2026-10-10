import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Brain, CheckCircle, Code, Crown, Key, MapPin, PaperPlaneTilt, Timer, TreeStructure, X } from "phosphor-react-native";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PurchasesPackage } from "react-native-purchases";

import { useToast } from "@/src/components/toast";
import { Button, Sheet } from "@/src/components/ui";
import { isTestStore, useSubscription } from "@/src/revenuecat";
import { fonts, makeStyles, radius, spacing, useTheme } from "@/src/theme";

const FEATURES = [
  { icon: TreeStructure, text: "Unlimited workflows" },
  { icon: Timer, text: "Scheduled automations" },
  { icon: PaperPlaneTilt, text: "Telegram, Slack, Discord, Email and Google steps" },
  { icon: MapPin, text: "Place triggers on your phone" },
  { icon: Code, text: "Python code step" },
  { icon: Key, text: "Credentials vault for any custom API" },
  { icon: Brain, text: "Local LLM (Ollama / LM Studio) and unlimited agent chat" },
];

export default function Paywall() {
  const { feature } = useLocalSearchParams<{ feature?: string }>();
  const router = useRouter();
  const toast = useToast();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { offerings, isLoading, isSubscribed, identityReady, identityError, purchase, restore, isPurchasing, isRestoring } =
    useSubscription();
  const packages = useMemo(() => offerings?.current?.availablePackages ?? [], [offerings]);
  const [selected, setSelected] = useState<PurchasesPackage | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected && packages.length) {
      setSelected(packages.find((p) => p.identifier === "$rc_annual") ?? packages[0]);
    }
  }, [packages, selected]);

  const monthly = packages.find((p) => p.identifier === "$rc_monthly");
  const close = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const label = (p: PurchasesPackage) =>
    p.identifier === "$rc_annual" ? "Yearly" : p.identifier === "$rc_monthly" ? "Monthly" : p.product.title;
  const period = (p: PurchasesPackage) => (p.identifier === "$rc_annual" ? "/year" : p.identifier === "$rc_monthly" ? "/month" : "");
  // Free trial comes from the store product (iOS introPrice / Android free phase)
  const trial = (p: PurchasesPackage): string | null => {
    const intro = p.product.introPrice;
    if (intro && intro.price === 0) {
      const unit = intro.periodUnit.toLowerCase();
      const n = intro.periodNumberOfUnits;
      return unit === "week" && n === 1 ? "7-day" : `${n}-${unit}`;
    }
    const free = p.product.defaultOption?.freePhase?.billingPeriod;
    if (free) {
      const unit = free.unit.toLowerCase();
      return unit === "week" && free.value === 1 ? "7-day" : `${free.value}-${unit}`;
    }
    return null;
  };
  const savings = (p: PurchasesPackage) => {
    if (p.identifier !== "$rc_annual" || !monthly) return null;
    const pct = Math.round((1 - p.product.price / (monthly.product.price * 12)) * 100);
    return pct > 0 ? `SAVE ${pct}%` : null;
  };

  const doPurchase = async () => {
    if (!selected) return;
    setConfirm(false);
    setError(null);
    try {
      const info = await purchase(selected);
      if (info.entitlements.active.pro) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        toast("Welcome to Automata Pro", "success");
        close();
      }
    } catch (e: any) {
      if (e?.userCancelled) return;
      setError(e?.message === "identity_not_ready" ? "Account not ready yet. Please try again in a moment." : e?.message ?? "Purchase failed");
    }
  };

  const doRestore = async () => {
    setError(null);
    try {
      const info = await restore();
      toast(info.entitlements.active.pro ? "Pro restored" : "No previous purchase found", info.entitlements.active.pro ? "success" : "info");
    } catch (e: any) {
      setError(e?.message ?? "Restore failed");
    }
  };

  return (
    <View style={styles.root} testID="paywall-screen">
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl }]}>
        <Pressable onPress={close} style={styles.close} testID="paywall-close-button" hitSlop={8}>
          <X size={22} color={colors.onSurface} />
        </Pressable>
        <View style={styles.crown}>
          <Crown size={36} color={colors.onBrandPrimary} weight="fill" />
        </View>
        <Text style={styles.title}>AUTOMATA PRO</Text>
        <Text style={styles.subtitle}>
          {feature ? `${feature} is a Pro feature. ` : ""}Automate everything, without limits.
        </Text>

        {isSubscribed ? (
          <View style={styles.active} testID="paywall-already-pro">
            <CheckCircle size={22} color={colors.success} weight="fill" />
            <Text style={styles.activeText}>You have Pro. All features are unlocked.</Text>
          </View>
        ) : null}

        <View style={styles.features}>
          {FEATURES.map((f, i) => (
            <Animated.View key={f.text} entering={FadeInDown.delay(i * 40)} style={styles.featureRow}>
              <f.icon size={20} color={colors.brandPrimary} />
              <Text style={styles.featureText}>{f.text}</Text>
            </Animated.View>
          ))}
        </View>

        {identityError && (
          <View style={styles.banner} testID="paywall-identity-error">
            <Text style={styles.bannerText}>{`Purchases unavailable: ${identityError}`}</Text>
          </View>
        )}
        {error && (
          <View style={styles.banner} testID="paywall-error">
            <Text style={styles.bannerText}>{error}</Text>
          </View>
        )}

        {isLoading ? (
          <ActivityIndicator color={colors.brandPrimary} style={{ marginVertical: spacing.xl }} />
        ) : packages.length === 0 ? (
          <Text style={styles.unavailable} testID="paywall-unavailable">
            Subscription options are unavailable right now. Please try again later.
          </Text>
        ) : (
          <View style={{ gap: spacing.md }}>
            {packages.map((p) => {
              const on = selected?.identifier === p.identifier;
              const save = savings(p);
              return (
                <Pressable key={p.identifier} onPress={() => setSelected(p)} style={[styles.pkg, on && styles.pkgOn]} testID={`paywall-package-${p.identifier}`}>
                  <View style={[styles.radio, on && styles.radioOn]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pkgTitle}>{label(p)}</Text>
                    <Text style={styles.pkgPrice}>{`${p.product.priceString}${period(p)}`}</Text>
                    {trial(p) && (
                      <Text style={styles.trial} testID={`paywall-trial-${p.identifier}`}>{`${trial(p)} free trial`}</Text>
                    )}
                  </View>
                  {save && (
                    <View style={styles.save}>
                      <Text style={styles.saveText}>{save}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      {!isSubscribed && packages.length > 0 && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          <Button
            title={
              selected
                ? trial(selected)
                  ? `Start ${trial(selected)} free trial`
                  : `Continue · ${selected.product.priceString}${period(selected)}`
                : "Continue"
            }
            onPress={() => (isTestStore ? setConfirm(true) : doPurchase())}
            loading={isPurchasing}
            disabled={!selected || !identityReady}
            testID="paywall-purchase-button"
          />
          <Pressable onPress={doRestore} style={styles.restore} disabled={isRestoring} testID="paywall-restore-button">
            <Text style={styles.restoreText}>{isRestoring ? "Restoring..." : "Restore purchases"}</Text>
          </Pressable>
          <Text style={styles.legal}>
            {selected && trial(selected)
              ? `Free for ${trial(selected)} period, then ${selected.product.priceString}${period(selected)}. Cancel before the trial ends and you won't be charged. Auto-renews until cancelled.`
              : "Auto-renews until cancelled. Cancel anytime in Google Play / App Store subscriptions."}
          </Text>
        </View>
      )}
      {isSubscribed && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          <Button title="Done" onPress={close} testID="paywall-done-button" />
        </View>
      )}

      <Sheet
        visible={confirm}
        onClose={() => setConfirm(false)}
        title="Test purchase (simulated)"
        testID="paywall-confirm-sheet"
        footer={
          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <Button title="Cancel" variant="ghost" onPress={() => setConfirm(false)} style={{ flex: 1 }} testID="paywall-confirm-cancel" />
            <Button title="Buy (test)" onPress={doPurchase} style={{ flex: 2 }} testID="paywall-confirm-buy" />
          </View>
        }
      >
        <Text style={styles.featureText}>
          {`This preview uses the RevenueCat Test Store. No real money is charged. Buy ${selected ? label(selected) : ""} for ${selected?.product.priceString ?? ""}?`}
        </Text>
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  content: { paddingHorizontal: spacing.lg },
  close: { alignSelf: "flex-end", width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  crown: { width: 64, height: 64, borderRadius: radius.lg, backgroundColor: c.brandPrimary, alignItems: "center", justifyContent: "center" },
  title: { color: c.onSurface, fontFamily: fonts.display, fontSize: 34, letterSpacing: 1.5, marginTop: spacing.lg },
  subtitle: { color: c.onSurfaceTertiary, fontFamily: fonts.body, fontSize: 15, lineHeight: 22, marginBottom: spacing.lg },
  features: { gap: spacing.md, marginBottom: spacing.xl },
  featureRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  featureText: { flex: 1, color: c.onSurfaceSecondary, fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  active: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.success, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.lg },
  activeText: { flex: 1, color: c.onSurface, fontFamily: fonts.medium },
  banner: { borderWidth: 1, borderColor: c.error, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, backgroundColor: c.surfaceSecondary },
  bannerText: { color: c.error, fontFamily: fonts.medium, fontSize: 13 },
  unavailable: { color: c.onSurfaceTertiary, fontFamily: fonts.body, fontSize: 14 },
  pkg: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceSecondary },
  pkgOn: { borderColor: c.brandPrimary, backgroundColor: c.brandTertiary },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.borderStrong },
  radioOn: { borderColor: c.brandPrimary, backgroundColor: c.brandPrimary },
  pkgTitle: { color: c.onSurface, fontFamily: fonts.display, fontSize: 20 },
  pkgPrice: { color: c.onSurfaceTertiary, fontFamily: fonts.mono, fontSize: 13 },
  trial: { color: c.success, fontFamily: fonts.displaySemi, fontSize: 13, letterSpacing: 0.5, marginTop: 2 },
  save: { backgroundColor: c.brandPrimary, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  saveText: { color: c.onBrandPrimary, fontFamily: fonts.display, fontSize: 12, letterSpacing: 0.8 },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: c.border, gap: spacing.sm },
  restore: { alignItems: "center", justifyContent: "center", minHeight: 44 },
  restoreText: { color: c.onSurfaceSecondary, fontFamily: fonts.medium, fontSize: 14, textDecorationLine: "underline" },
  legal: { color: c.muted, fontFamily: fonts.body, fontSize: 11, textAlign: "center" },
}));
