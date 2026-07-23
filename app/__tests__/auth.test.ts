// Pure-function tests for the auth store. AsyncStorage-backed persistence
// (saveAuth/loadAuth/clearAuth) is a thin passthrough to
// @react-native-async-storage/async-storage and isn't unit-tested here.
import {parseCookieString, sapisidHash, buildAuthHeaders} from '../src/auth/authStore';

describe('parseCookieString', () => {
  test('parses a simple "A=1; B=2" cookie header into a map', () => {
    expect(parseCookieString('A=1; B=2')).toEqual({A: '1', B: '2'});
  });

  test('is tolerant of irregular whitespace around pairs and separators', () => {
    expect(parseCookieString('  A=1;   B=2  ;C=3')).toEqual({A: '1', B: '2', C: '3'});
  });

  test('preserves "=" characters inside a value (e.g. base64 cookie values)', () => {
    expect(parseCookieString('TOKEN=abc==; OTHER=def')).toEqual({TOKEN: 'abc==', OTHER: 'def'});
  });

  test('ignores empty segments produced by trailing/double semicolons', () => {
    expect(parseCookieString('A=1;; B=2;')).toEqual({A: '1', B: '2'});
  });

  test('returns an empty map for an empty string', () => {
    expect(parseCookieString('')).toEqual({});
  });

  test('skips segments with no "=" separator', () => {
    expect(parseCookieString('A=1; garbage; B=2')).toEqual({A: '1', B: '2'});
  });
});

describe('sapisidHash', () => {
  test('matches the known SHA-1 test vector for the string "hello"', () => {
    // Reference vector (not sapisidHash itself, just confirming the
    // underlying SHA-1 implementation is correct):
    // sha1("hello") = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    const crypto = require('crypto');
    expect(crypto.createHash('sha1').update('hello', 'utf8').digest('hex')).toBe(
      'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    );
  });

  test('produces the documented SAPISIDHASH vector for a known input', () => {
    // Derived once via `node -e` using Node's built-in crypto module:
    //   const crypto = require('crypto');
    //   const sapisid = 'abc123DEF456';
    //   const origin = 'https://music.youtube.com';
    //   const nowMs = 1700000000000;
    //   const seconds = Math.floor(nowMs / 1000); // 1700000000
    //   const input = `${seconds} ${sapisid} ${origin}`;
    //   sha1hex(input) === '523b347dc761960824d5cee9cce8e04db5cd0114'.slice(0, 40)
    // giving the full hash below.
    const sapisid = 'abc123DEF456';
    const origin = 'https://music.youtube.com';
    const nowMs = 1700000000000;
    expect(sapisidHash(sapisid, origin, nowMs)).toBe(
      '1700000000_523b347dc761960824d5cee9cce8e04db5cd0114',
    );
  });

  test('floors sub-second precision in nowMs down to whole seconds', () => {
    const sapisid = 'abc123DEF456';
    const origin = 'https://music.youtube.com';
    // 1700000000.999s worth of ms -> still floors to 1700000000
    expect(sapisidHash(sapisid, origin, 1700000000999)).toBe(
      '1700000000_523b347dc761960824d5cee9cce8e04db5cd0114',
    );
  });
});

describe('buildAuthHeaders', () => {
  const nowMs = 1700000000000;

  test('extracts SAPISID from the cookie header and builds the expected headers', () => {
    const cookieHeader = 'SAPISID=abc123DEF456; OTHER=xyz';
    expect(buildAuthHeaders(cookieHeader, nowMs)).toEqual({
      cookie: cookieHeader,
      authorization: 'SAPISIDHASH 1700000000_523b347dc761960824d5cee9cce8e04db5cd0114',
      'x-origin': 'https://music.youtube.com',
    });
  });

  test('falls back to __Secure-3PAPISID when SAPISID is absent', () => {
    const cookieHeader = '__Secure-3PAPISID=abc123DEF456; OTHER=xyz';
    expect(buildAuthHeaders(cookieHeader, nowMs)).toEqual({
      cookie: cookieHeader,
      authorization: 'SAPISIDHASH 1700000000_523b347dc761960824d5cee9cce8e04db5cd0114',
      'x-origin': 'https://music.youtube.com',
    });
  });

  test('prefers SAPISID over __Secure-3PAPISID when both are present', () => {
    const cookieHeader = 'SAPISID=abc123DEF456; __Secure-3PAPISID=other-value';
    expect(buildAuthHeaders(cookieHeader, nowMs)).toEqual({
      cookie: cookieHeader,
      authorization: 'SAPISIDHASH 1700000000_523b347dc761960824d5cee9cce8e04db5cd0114',
      'x-origin': 'https://music.youtube.com',
    });
  });

  test('throws a descriptive error when neither cookie is present', () => {
    expect(() => buildAuthHeaders('FOO=bar', nowMs)).toThrow(/SAPISID/);
  });
});
