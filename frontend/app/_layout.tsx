import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { ErrorBoundary } from "@/src/components/error-boundary";
import { ToastProvider, useToast } from "@/src/components/toast";
import { deliverPendingActions } from "@/src/device";
import "@/src/geofence";
import { queryClient } from "@/src/query-client";
import { useTheme } from "@/src/theme";

/** Delivers phone actions (notifications etc.) queued by scheduled / webhook runs. */
function PendingActions() {
  const toast = useToast();
  useEffect(() => {
    deliverPendingActions(toast);
    const sub = AppState.addEventListener("change", (s) => s === "active" && deliverPendingActions(toast));
    const timer = setInterval(() => AppState.currentState === "active" && deliverPendingActions(toast), 60000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [toast]);
  return null;
}

// Disable logbox errors etc so that users can see the app
// and agent works as expected.
LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const { colors } = useTheme();
  const [loaded, error] = useFonts({
    "Rajdhani-Bold": require("../assets/fonts/Rajdhani-Bold.ttf"),
    "Rajdhani-SemiBold": require("../assets/fonts/Rajdhani-SemiBold.ttf"),
    "IBMPlexSans-Regular": require("../assets/fonts/IBMPlexSans-Regular.ttf"),
    "IBMPlexSans-Medium": require("../assets/fonts/IBMPlexSans-Medium.ttf"),
    "IBMPlexSans-SemiBold": require("../assets/fonts/IBMPlexSans-SemiBold.ttf"),
    "IBMPlexMono-Regular": require("../assets/fonts/IBMPlexMono-Regular.ttf"),
  });

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);

  if (!loaded && !error) return null;

  // One app level ErrorBoundary; a render crash shows a reload screen
  // instead of a blank app.
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.surface }}>
        <QueryClientProvider client={queryClient}>
          <KeyboardProvider>
            <ToastProvider>
              <StatusBar style="light" />
              <PendingActions />
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }} />
            </ToastProvider>
          </KeyboardProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
