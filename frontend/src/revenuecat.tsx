import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import Purchases, { LOG_LEVEL } from "react-native-purchases";
import type { CustomerInfo, PurchasesPackage } from "react-native-purchases";

import { api, getDeviceId, Plan } from "@/src/api";

const REVENUECAT_TEST_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
const REVENUECAT_IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
const REVENUECAT_ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;

export const REVENUECAT_ENTITLEMENT_IDENTIFIER = "pro";
/** RevenueCat is optional: a self-hosted backend may not sell subscriptions at all. */
export const rcConfigured = !!(REVENUECAT_TEST_API_KEY && REVENUECAT_IOS_API_KEY && REVENUECAT_ANDROID_API_KEY);
export const rcEnabled = rcConfigured && (Platform.OS !== "web" || __DEV__); // web preview uses the Test Store
export const isTestStore = Platform.OS === "web" || __DEV__;

// Free tier limits (Pro removes them)
export const FREE_WORKFLOW_LIMIT = 3;
export const FREE_AGENT_DAILY = 10;
export const PRO_STEPS = ["code", "telegram", "slack", "discord", "email", "sheets", "gmail", "drive", "calendar"];

function getRevenueCatApiKey() {
  if (!rcConfigured) {
    throw new Error("RevenueCat public API keys not set");
  }
  if (isTestStore) return REVENUECAT_TEST_API_KEY;
  if (Platform.OS === "ios") return REVENUECAT_IOS_API_KEY;
  if (Platform.OS === "android") return REVENUECAT_ANDROID_API_KEY;
  return REVENUECAT_TEST_API_KEY;
}

export function initializeRevenueCat() {
  if (!rcEnabled) return;
  Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN);
  Purchases.configure({ apiKey: getRevenueCatApiKey() });
}

function useSubscriptionContext() {
  const queryClient = useQueryClient();
  const rcIdentityRef = useRef<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);

  // Bind purchases to this install's stable app user id (same id the backend scopes data by).
  useEffect(() => {
    if (!rcEnabled) return;
    (async () => {
      try {
        const id = await getDeviceId();
        if (rcIdentityRef.current === id) return;
        const { customerInfo } = await Purchases.logIn(id);
        rcIdentityRef.current = id;
        setIdentityError(null);
        queryClient.setQueryData(["revenuecat", "customer-info"], customerInfo);
      } catch (e: any) {
        setIdentityError(e?.message ?? String(e));
      }
    })();
  }, [queryClient]);

  // The backend is the source of truth for entitlements: a self-hosted server
  // running with BILLING_MODE=open reports pro: true for every install.
  const planQuery = useQuery({
    queryKey: ["plan"],
    queryFn: () => api<Plan>("/plan"),
    staleTime: 60 * 1000,
  });

  const customerInfoQuery = useQuery({
    queryKey: ["revenuecat", "customer-info"],
    queryFn: () => Purchases.getCustomerInfo(),
    enabled: rcEnabled,
    staleTime: 60 * 1000,
  });

  const offeringsQuery = useQuery({
    queryKey: ["revenuecat", "offerings"],
    queryFn: () => Purchases.getOfferings(),
    enabled: rcEnabled,
    staleTime: 300 * 1000,
  });

  useEffect(() => {
    if (!rcEnabled) return;
    const listener = (info: CustomerInfo) => queryClient.setQueryData(["revenuecat", "customer-info"], info);
    Purchases.addCustomerInfoUpdateListener(listener);
    return () => {
      Purchases.removeCustomerInfoUpdateListener(listener);
    };
  }, [queryClient]);

  const purchaseMutation = useMutation({
    mutationFn: async (pkg: PurchasesPackage) => {
      const id = (await Purchases.getCustomerInfo()).originalAppUserId;
      if (id.startsWith("$RCAnonymousID:")) throw new Error("identity_not_ready");
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      return customerInfo;
    },
  });

  const restoreMutation = useMutation({ mutationFn: () => Purchases.restorePurchases() });

  const serverPro = planQuery.data?.pro === true;
  const isSubscribed = serverPro ||
    customerInfoQuery.data?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER] !== undefined;
  const originalAppUserId = customerInfoQuery.data?.originalAppUserId;
  const identityReady = !!originalAppUserId && !originalAppUserId.startsWith("$RCAnonymousID:");

  return {
    plan: planQuery.data,
    customerInfo: customerInfoQuery.data,
    offerings: offeringsQuery.data,
    offeringsError: offeringsQuery.error,
    isSubscribed,
    identityReady,
    identityError,
    isLoading: customerInfoQuery.isLoading || offeringsQuery.isLoading,
    purchase: purchaseMutation.mutateAsync,
    restore: restoreMutation.mutateAsync,
    isPurchasing: purchaseMutation.isPending,
    isRestoring: restoreMutation.isPending,
  };
}

type SubscriptionContextValue = ReturnType<typeof useSubscriptionContext>;
const Context = createContext<SubscriptionContextValue | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const value = useSubscriptionContext();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSubscription() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useSubscription must be used within a SubscriptionProvider");
  return ctx;
}

/** Returns a guard: true when Pro, otherwise opens the paywall and returns false. */
export function useRequirePro() {
  const { isSubscribed } = useSubscription();
  const router = useRouter();
  return (feature: string) => {
    if (isSubscribed) return true;
    router.push({ pathname: "/paywall", params: { feature } });
    return false;
  };
}
