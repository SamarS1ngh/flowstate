import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {colors, radii, spacing} from './theme';

/**
 * Row-shaped loading placeholders that mirror ListRow's layout (thumb + two
 * text lines), gently pulsing. Shown while the library/playlist loads instead
 * of a bare centered spinner, so the screen reads as "content is coming" with
 * the right shape already in place.
 */
export default function SkeletonList({rows = 8}: {rows?: number}) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 700, useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 0.4, duration: 700, useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.container}>
      {Array.from({length: rows}).map((_, i) => (
        <View key={i} style={styles.row}>
          <Animated.View style={[styles.thumb, {opacity: pulse}]} />
          <View style={styles.textCol}>
            <Animated.View style={[styles.lineWide, {opacity: pulse}]} />
            <Animated.View style={[styles.lineNarrow, {opacity: pulse}]} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {paddingVertical: spacing.sm},
  row: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md},
  thumb: {width: 56, height: 56, borderRadius: radii.sm, backgroundColor: colors.surfaceRaised},
  textCol: {flex: 1, marginLeft: spacing.md},
  lineWide: {height: 14, width: '70%', borderRadius: 4, backgroundColor: colors.surfaceRaised, marginBottom: spacing.sm},
  lineNarrow: {height: 12, width: '40%', borderRadius: 4, backgroundColor: colors.surfaceRaised},
});
