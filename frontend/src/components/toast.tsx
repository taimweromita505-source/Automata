import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { Text } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fonts, makeStyles, radius, spacing } from "@/src/theme";

type Kind = "success" | "error" | "info";
const ToastCtx = createContext<(msg: string, kind?: Kind) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; kind: Kind; key: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const styles = useStyles();

  const show = useCallback((msg: string, kind: Kind = "info") => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ msg, kind, key: Date.now() });
    timer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <Animated.View
          key={toast.key}
          entering={FadeInUp}
          exiting={FadeOutUp}
          style={[styles.toast, { pointerEvents: "none" }, styles[toast.kind], { top: insets.top + spacing.sm }]}
          testID="toast-message"
        >
          <Text style={styles.text}>{toast.msg}</Text>
        </Animated.View>
      )}
    </ToastCtx.Provider>
  );
}

const useStyles = makeStyles((c) => ({
  toast: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: c.surfaceSecondary,
  },
  success: { borderColor: c.success },
  error: { borderColor: c.error },
  info: { borderColor: c.brandPrimary },
  text: { color: c.onSurface, fontFamily: fonts.medium, fontSize: 14 },
}));
