import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Icon, {IconName} from './Icon';
import {bottomNavHeight, colors} from './theme';

export type BottomNavKey = 'Library' | 'Settings';

const TABS: Array<{key: BottomNavKey; label: string; icon: IconName}> = [
  {key: 'Library', label: 'Library', icon: 'library'},
  {key: 'Settings', label: 'Settings', icon: 'settings'},
];

// Bottom tab bar (Task 3). Only two destinations exist as real screens
// today (Library, Settings) -- the brief allows "at least Library, Search
// or Settings", so this satisfies it without inventing a Search screen that
// doesn't exist yet. Built as a plain component rather than
// @react-navigation/bottom-tabs so no new nav dependency/restructuring of
// the existing native-stack is needed -- see App.tsx for how it's composed
// alongside the Stack.Navigator.
export default function BottomNav({
  active,
  onNavigate,
}: {
  active: BottomNavKey | null;
  onNavigate: (key: BottomNavKey) => void;
}) {
  return (
    <View style={styles.bar}>
      {/* Bright neon top rail -- reads as the HUD's lower dock edge. */}
      <View style={styles.rail} />
      {TABS.map(tab => {
        const isActive = tab.key === active;
        const color = isActive ? colors.neon : colors.textTertiary;
        return (
          <Pressable key={tab.key} style={styles.tab} onPress={() => onNavigate(tab.key)}>
            {/* Active tab lights an upper tick + neon icon/label. */}
            <View style={[styles.tick, isActive && styles.tickActive]} />
            <Icon name={tab.icon} size={20} color={color} />
            <Text style={[styles.label, {color}]}>{tab.label.toUpperCase()}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: bottomNavHeight,
    flexDirection: 'row',
    backgroundColor: colors.bg,
  },
  rail: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.glassBorder,
  },
  tab: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  tick: {width: 22, height: 2, borderRadius: 1, marginBottom: 6, backgroundColor: 'transparent'},
  tickActive: {backgroundColor: colors.neon},
  label: {
    fontSize: 10,
    marginTop: 3,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 1.5,
  },
});
