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
