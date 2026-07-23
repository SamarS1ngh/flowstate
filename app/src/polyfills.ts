// youtubei.js needs web platform APIs that React Native lacks.
// Order matters; import this file FIRST in index.js.
import 'react-native-url-polyfill/auto';
import 'event-target-polyfill';
import 'web-streams-polyfill/polyfill';
import 'text-encoding-polyfill';
import {decode, encode} from 'base-64';

// Use `globalThis` rather than `global`: this project's tsconfig has no
// Node type defs (only "jest"), so the ambient `global` identifier isn't
// declared, while `globalThis` is standard and resolves under both RN and
// Node (used by the Step 4 live check in plain Node).
if (!globalThis.atob) globalThis.atob = decode;
if (!globalThis.btoa) globalThis.btoa = encode;

// event-target-polyfill only installs Event/EventTarget, not CustomEvent.
// youtubei.js's EventEmitterLike.emit() (used by Session/Player under the
// hood) does `new Platform.shim.CustomEvent(type, {detail})`, and youtubei.js's
// own react-native integration guide (src/platform/react-native.md) requires
// this exact polyfill. Without it, `Platform.shim.CustomEvent` is undefined
// and emit() throws as soon as anything on the Session/Player emits an event.
// See https://github.com/LuanRT/YouTube.js/blob/main/src/platform/react-native.md
if (!globalThis.CustomEvent) {
  const BaseEvent = globalThis.Event as any;
  class CustomEventPolyfill extends BaseEvent {
    detail: unknown;
    constructor(type: string, options?: {detail?: unknown} & Record<string, unknown>) {
      super(type, options);
      this.detail = options?.detail ?? null;
    }
  }
  // @ts-expect-error assigning our lightweight CustomEvent polyfill onto globalThis
  globalThis.CustomEvent = CustomEventPolyfill;
}
