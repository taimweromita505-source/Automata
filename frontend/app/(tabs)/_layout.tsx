import { Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { ClockCounterClockwise, GearSix, Robot, TreeStructure } from "phosphor-react-native";
import { Platform } from "react-native";

import { usesNativeTabs } from "@/src/navigation";
import { fonts, useTheme } from "@/src/theme";

export default function TabsLayout() {
  const { colors } = useTheme();

  if (usesNativeTabs) {
    return (
      <NativeTabs tintColor={colors.brandPrimary}>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf="sparkles" />
          <NativeTabs.Trigger.Label>Agent</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="workflows">
          <NativeTabs.Trigger.Icon sf="point.3.connected.trianglepath.dotted" />
          <NativeTabs.Trigger.Label>Workflows</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="runs">
          <NativeTabs.Trigger.Icon sf="clock.arrow.circlepath" />
          <NativeTabs.Trigger.Label>Runs</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="settings">
          <NativeTabs.Trigger.Icon sf="gearshape" />
          <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    );
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surfaceSecondary,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          ...(Platform.OS === "web" ? { height: 64 } : {}),
        },
        tabBarItemStyle: { alignSelf: "center" },
        tabBarLabelStyle: { fontFamily: fonts.displaySemi, fontSize: 12, letterSpacing: 0.5 },
        sceneStyle: { backgroundColor: colors.surface },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Agent",
          tabBarButtonTestID: "tab-agent",
          tabBarIcon: ({ color, focused }) => <Robot size={24} color={color as string} weight={focused ? "fill" : "regular"} />,
        }}
      />
      <Tabs.Screen
        name="workflows"
        options={{
          title: "Workflows",
          tabBarButtonTestID: "tab-workflows",
          tabBarIcon: ({ color, focused }) => (
            <TreeStructure size={24} color={color as string} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
      <Tabs.Screen
        name="runs"
        options={{
          title: "Runs",
          tabBarButtonTestID: "tab-runs",
          tabBarIcon: ({ color, focused }) => (
            <ClockCounterClockwise size={24} color={color as string} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarButtonTestID: "tab-settings",
          tabBarIcon: ({ color, focused }) => <GearSix size={24} color={color as string} weight={focused ? "fill" : "regular"} />,
        }}
      />
    </Tabs>
  );
}
