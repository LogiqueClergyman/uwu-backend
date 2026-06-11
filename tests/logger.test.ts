/**
 * logger unit tests — the structured, redacting, ring-buffered backend logger.
 *
 * console.log is silenced so the suite output stays clean; we assert on the
 * in-memory buffer (log.recent / log.clear) and on the redaction of secrets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log } from '../src/services/logger';

beforeEach(() => {
  log.clear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('redaction', () => {
  it('masks sensitive keys but preserves benign ones', () => {
    log.info('SETU', 'mixed payload', {
      secret: 'a',
      token: 'b',
      clientSecret: 'c',
      password: 'd',
      mnemonic: 'e',
      privateKey: 'f',
      seed: 'g',
      sk: 'h',
      email: 'user@example.com',
      apiKey: 'public-key',
      platformName: 'Acme',
    });

    const data = log.recent(1)[0].data as Record<string, string>;
    for (const k of ['secret', 'token', 'clientSecret', 'password', 'mnemonic', 'privateKey', 'seed', 'sk']) {
      expect(data[k]).toBe('••redacted••');
    }
    expect(data.email).toBe('user@example.com');
    expect(data.apiKey).toBe('public-key');
    expect(data.platformName).toBe('Acme');
  });

  it('leaves string and array payloads untouched', () => {
    log.info('DB', 'string payload', 'just-a-string');
    log.info('DB', 'array payload', [1, 2, 3]);
    const entries = log.recent(2);
    expect(entries[0].data).toBe('just-a-string');
    expect(entries[1].data).toEqual([1, 2, 3]);
  });

  it('omits data entirely when none is provided', () => {
    log.info('BOOT', 'no payload');
    expect(log.recent(1)[0].data).toBeUndefined();
  });
});

describe('buffer & recent()', () => {
  it('returns entries newest-last and honours the limit', () => {
    for (let i = 0; i < 5; i++) log.info('INTENT', String(i));
    const last3 = log.recent(3);
    expect(last3.map((e) => e.message)).toEqual(['2', '3', '4']);
  });

  it('filters by category', () => {
    log.info('AUTH', 'a1');
    log.info('KEYS', 'k1');
    log.warn('AUTH', 'a2');
    const auth = log.recent(10, 'AUTH');
    expect(auth).toHaveLength(2);
    expect(auth.every((e) => e.category === 'AUTH')).toBe(true);
  });

  it('caps the ring buffer at 1000 entries', () => {
    for (let i = 0; i < 1100; i++) log.debug('DB', String(i));
    expect(log.recent(5000)).toHaveLength(1000);
    // oldest 100 were evicted → first retained message is "100"
    expect(log.recent(5000)[0].message).toBe('100');
  });

  it('records level and an ISO timestamp on each entry', () => {
    log.success('CHAIN', 'anchored');
    const e = log.recent(1)[0];
    expect(e.level).toBe('success');
    expect(e.category).toBe('CHAIN');
    expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
  });
});

describe('clear()', () => {
  it('empties the buffer', () => {
    log.info('DB', 'x');
    expect(log.recent().length).toBeGreaterThan(0);
    log.clear();
    expect(log.recent()).toHaveLength(0);
  });
});
