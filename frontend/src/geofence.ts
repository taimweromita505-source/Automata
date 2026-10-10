import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import { api, Run, Workflow } from "@/src/api";
import { executeDeviceActions } from "@/src/device";

export const GEOFENCE_TASK = "automata-geofence";
export const geofenceSupported = Platform.OS !== "web";

// Background task must be defined at module scope (imported from the root layout).
if (geofenceSupported) {
  TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody<any>) => {
    if (error || !data) return;
    const { eventType, region } = data;
    const ev = eventType === Location.GeofencingEventType.Enter ? "enter" : "exit";
    const [wfId, wanted] = String(region?.identifier ?? "").split(":");
    if (!wfId || wanted !== ev) return;
    try {
      const run = await api<Run>(`/workflows/${wfId}/run`, {
        method: "POST",
        body: {
          trigger: "location",
          input: JSON.stringify({ event: ev, latitude: region.latitude, longitude: region.longitude }),
        },
      });
      await executeDeviceActions(run.device_actions);
    } catch {}
  });
}

/** Registers geofences for every active location-triggered workflow. */
export async function syncGeofences(): Promise<{ ok: boolean; count: number; reason?: string }> {
  if (!geofenceSupported) return { ok: false, count: 0, reason: "Location triggers need the installed app" };
  const workflows = await api<Workflow[]>("/workflows");
  const regions = workflows
    .filter((w) => w.active && w.trigger.type === "location" && w.trigger.latitude != null && w.trigger.longitude != null)
    .map((w) => ({
      identifier: `${w.id}:${w.trigger.event ?? "enter"}`,
      latitude: Number(w.trigger.latitude),
      longitude: Number(w.trigger.longitude),
      radius: Math.max(100, w.trigger.radius ?? 200),
      notifyOnEnter: (w.trigger.event ?? "enter") === "enter",
      notifyOnExit: w.trigger.event === "exit",
    }));
  const bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted) return { ok: false, count: regions.length, reason: "Background location not allowed" };
  try {
    const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    if (!regions.length) {
      if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
      return { ok: true, count: 0 };
    }
    await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
    return { ok: true, count: regions.length };
  } catch (e: any) {
    return { ok: false, count: regions.length, reason: e?.message ?? "Geofencing unavailable (needs installed build)" };
  }
}
