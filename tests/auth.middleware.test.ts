/**
 * auth.middleware unit tests — platform API-key authentication.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockReq, mockRes } from './helpers/http';

const h = vi.hoisted(() => {
  const queue: any[] = [];
  const chain = (): any => {
    const c: any = {};
    for (const m of ['where', 'limit', 'from']) c[m] = () => chain();
    c.then = (resolve: any, reject: any) => {
      const item = queue.length ? queue.shift() : [];
      if (item && (item as any).__throw) return Promise.reject((item as any).__throw).then(resolve, reject);
      return Promise.resolve(item).then(resolve, reject);
    };
    return c;
  };
  return {
    db: { select: () => chain() },
    enqueue: (r: any) => queue.push(r),
    enqueueThrow: (e: any) => queue.push({ __throw: e }),
    reset: () => { queue.length = 0; },
  };
});

vi.mock('../src/db', () => ({ db: h.db }));
vi.mock('../src/services/logger', () => ({
  log: { info() {}, success() {}, warn() {}, error() {}, debug() {}, recent: () => [], clear() {} },
}));

import { authenticatePlatformKey } from '../src/middleware/auth.middleware';

beforeEach(() => h.reset());

it('401s when the X-UwU-API-Key header is absent', async () => {
  const res = mockRes();
  const next = vi.fn();
  await authenticatePlatformKey(mockReq({ headers: {} }), res, next);
  expect(res.statusCode).toBe(401);
  expect(next).not.toHaveBeenCalled();
});

it('401s when the key is not found', async () => {
  h.enqueue([]); // select → no row
  const res = mockRes();
  const next = vi.fn();
  await authenticatePlatformKey(mockReq({ headers: { 'x-uwu-api-key': 'bogus' } }), res, next);
  expect(res.statusCode).toBe(401);
  expect(next).not.toHaveBeenCalled();
});

it('attaches platformConfig and calls next() for a valid key', async () => {
  const config = { apiKey: 'pub', platformName: 'Acme', setuApiKey: 'setu', usageCount: 1, successCount: 0 };
  h.enqueue([config]);
  const res = mockRes();
  const next = vi.fn();
  const req = mockReq({ headers: { 'x-uwu-api-key': 'pub' } });
  await authenticatePlatformKey(req, res, next);
  expect(next).toHaveBeenCalledOnce();
  expect(req.platformConfig).toEqual(config);
});

it('500s on a database error', async () => {
  h.enqueueThrow(new Error('db down'));
  const res = mockRes();
  const next = vi.fn();
  await authenticatePlatformKey(mockReq({ headers: { 'x-uwu-api-key': 'pub' } }), res, next);
  expect(res.statusCode).toBe(500);
  expect(next).not.toHaveBeenCalled();
});
