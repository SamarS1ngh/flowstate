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

// youtubei.js's react-native platform shim's uuidv4() (used to generate a
// device_id for OAuth2's device-code grant request -- see
// node_modules/youtubei.js/bundle/react-native.js's Platform.load({...
// uuidv4() {...} })) is:
//   uuidv4() {
//     if (globalThis.crypto?.randomUUID()) { return globalThis.crypto.randomUUID(); }
//     return "...".replace(/[018]/g, cc => (... window.crypto.getRandomValues(...) ...));
//   }
// React Native/Hermes provides no `crypto` global at all, so the FIRST
// on-device symptom (confirmed) was the fallback branch throwing "Cannot
// read property 'getRandomValues' of undefined" (no `window.crypto`
// either). Adding only `crypto.getRandomValues` (first attempt) traded that
// for a second on-device failure (also confirmed): `crypto?.randomUUID()`
// only short-circuits when `crypto` ITSELF is nullish -- once `crypto`
// exists but has no `randomUUID` method, `crypto?.randomUUID()` still
// *calls* the (missing) method and throws "undefined is not a function".
// The fix is to also provide a working `randomUUID`, implemented on top of
// the same getRandomValues below (standard RFC 4122-shaped v4 UUID), so
// that branch actually succeeds and the library's fallback line (which
// references a bare `window` that doesn't exist as a RN global either) is
// never reached at all. device_id is just an opaque per-request identifier
// Google's device/code endpoint uses to correlate polling requests, not a
// security credential, so a Math.random()-backed source of randomness is
// adequate here (this intentionally does NOT polyfill crypto.subtle or
// claim cryptographic strength -- it exists solely to satisfy this one call
// site's shape, not as a general Web Crypto polyfill).
if (!globalThis.crypto) {
  // @ts-expect-error assigning a minimal crypto shim (getRandomValues + randomUUID only)
  globalThis.crypto = {};
}
if (!globalThis.crypto.getRandomValues) {
  globalThis.crypto.getRandomValues = function getRandomValues<
    T extends ArrayBufferView | null,
  >(array: T): T {
    if (array != null) {
      const bytes = new Uint8Array(
        array.buffer,
        array.byteOffset,
        array.byteLength,
      );
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return array;
  };
}
if (!globalThis.crypto.randomUUID) {
  globalThis.crypto.randomUUID = function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
  };
}
