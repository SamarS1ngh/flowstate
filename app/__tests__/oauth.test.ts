// Pure-function tests for oauth.ts. getAuthedInnertube/startDeviceLogin are
// integration glue around youtubei.js's Session/OAuth2 classes and
// AsyncStorage and aren't unit-tested here (see src/auth/oauth.ts and the
// Node scratch-script transcript in the task report for how that path was
// verified instead).
import {describeAuthError} from '../src/auth/oauth';

describe('describeAuthError', () => {
  test('maps an access-denied error to a friendly retry message', () => {
    expect(describeAuthError(new Error('Access was denied.'))).toBe(
      'Sign-in was denied. Tap retry to get a new code.',
    );
  });

  test('is case-insensitive and tolerant of message phrasing around "denied"', () => {
    expect(describeAuthError(new Error('access_denied by user'))).toBe(
      'Sign-in was denied. Tap retry to get a new code.',
    );
  });

  test('maps an expired-code error to a friendly retry message', () => {
    expect(describeAuthError(new Error('The device code has expired.'))).toBe(
      'That code expired before it was used. Tap retry to get a new one.',
    );
  });

  test('passes through any other Error message verbatim', () => {
    expect(describeAuthError(new Error('Server returned an unexpected error.'))).toBe(
      'Server returned an unexpected error.',
    );
  });

  test('falls back to a generic message for a non-Error thrown value', () => {
    expect(describeAuthError('some string')).toBe(
      'Sign-in failed for an unknown reason. Tap retry to try again.',
    );
  });

  test('falls back to a generic message for an Error with an empty message', () => {
    expect(describeAuthError(new Error(''))).toBe(
      'Sign-in failed for an unknown reason. Tap retry to try again.',
    );
  });
});
