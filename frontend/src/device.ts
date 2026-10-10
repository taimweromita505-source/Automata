import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { Linking, Platform, Share } from "react-native";

import { api, DeviceAction } from "@/src/api";

const native = Platform.OS !== "web";

if (native) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === "android") {
    Notifications.setNotificationChannelAsync("automations", {
      name: "Automations",
      importance: Notifications.AndroidImportance.HIGH,
    }).catch(() => {});
  }
}

export async function getNotificationPermission() {
  if (!native) return { granted: false, canAskAgain: false, status: "unavailable" as const };
  return Notifications.getPermissionsAsync();
}

export async function requestNotificationPermission() {
  if (!native) return { granted: false, canAskAgain: false, status: "unavailable" as const };
  return Notifications.requestPermissionsAsync();
}

type Notify = (msg: string, kind?: "success" | "error" | "info") => void;

/** Executes phone actions produced by a workflow or the agent. */
export async function executeDeviceActions(actions: DeviceAction[], toast?: Notify) {
  for (const a of actions ?? []) {
    try {
      if (a.action === "notify") {
        const perm = await getNotificationPermission();
        if (native && perm.granted) {
          await Notifications.scheduleNotificationAsync({
            content: { title: a.title || "Automata", body: a.text.slice(0, 400) },
            trigger: Platform.OS === "android" ? { channelId: "automations" } : null,
          });
        } else {
          toast?.(`${a.title || "Automata"}: ${a.text.slice(0, 160)}`, "info");
        }
      } else if (a.action === "clipboard") {
        await Clipboard.setStringAsync(a.text);
        toast?.("Copied to clipboard", "success");
      } else if (a.action === "open_url") {
        if (a.url) await Linking.openURL(a.url);
      } else if (a.action === "share") {
        await Share.share({ message: a.text });
      } else if (a.action === "vibrate") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      toast?.(`Phone action "${a.action}" failed`, "error");
    }
  }
}

/** Delivers phone actions queued by background (schedule / webhook) runs. */
export async function deliverPendingActions(toast?: Notify) {
  try {
    const actions = await api<DeviceAction[]>("/device/pending");
    if (actions.length) await executeDeviceActions(actions, toast);
  } catch {}
}
