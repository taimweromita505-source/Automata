import React from "react";
import { Linking, Text, View } from "react-native";

import { Button, Sheet } from "@/src/components/ui";
import { fonts, makeStyles, spacing } from "@/src/theme";

/** Pre-permission explanation shown before any native prompt; switches to Open Settings when blocked. */
export function PermissionSheet({
  visible,
  title,
  benefit,
  blocked,
  onAllow,
  onClose,
  testID,
}: {
  visible: boolean;
  title: string;
  benefit: string;
  blocked: boolean;
  onAllow: () => void;
  onClose: () => void;
  testID: string;
}) {
  const styles = useStyles();
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      testID={testID}
      footer={
        <View style={styles.row}>
          <Button title="Not now" variant="ghost" onPress={onClose} style={{ flex: 1 }} testID={`${testID}-later`} />
          {blocked ? (
            <Button
              title="Open settings"
              onPress={() => {
                onClose();
                Linking.openSettings();
              }}
              style={{ flex: 2 }}
              testID={`${testID}-open-settings`}
            />
          ) : (
            <Button title="Continue" onPress={onAllow} style={{ flex: 2 }} testID={`${testID}-allow`} />
          )}
        </View>
      }
    >
      <Text style={styles.text}>{benefit}</Text>
      {blocked && (
        <Text style={styles.blocked}>Permission is turned off. Enable it in your phone settings to use this feature.</Text>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((c) => ({
  row: { flexDirection: "row", gap: spacing.md },
  text: { color: c.onSurfaceSecondary, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  blocked: { color: c.warning, fontFamily: fonts.medium, fontSize: 13, marginTop: spacing.md },
}));
