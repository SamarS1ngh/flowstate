import {NativeModules} from 'react-native';

// Wi-Fi + partial-wake locks held WHILE MUSIC PLAYS. Without them, backgrounding
// / screen-off puts Wi-Fi in power-save and throttles the app's CPU, which
// STALLS the network resolve every skip needs -- so notification skips die once
// the pre-buffered songs run out. Holding these keeps background resolves
// flowing so skipping (and gapless auto-advance) works indefinitely, the same
// fix that made background analysis reliable. Native impl: AnalysisServiceModule.
const svc = NativeModules.AnalysisService as
  | {holdPlaybackLocks?: () => void; releasePlaybackLocks?: () => void}
  | undefined;

export function holdPlaybackLocks(): void {
  try {
    svc?.holdPlaybackLocks?.();
  } catch {
    // best-effort; playback still works, just less reliably in the background
  }
}

export function releasePlaybackLocks(): void {
  try {
    svc?.releasePlaybackLocks?.();
  } catch {
    // ignore
  }
}
