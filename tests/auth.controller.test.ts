/**
 * auth.controller unit tests — dashboard user signup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockReq, mockRes } from './helpers/http';

const h = vi.hoisted(() => {
  const queue: any[] = [];
  const chain = (): any => {
    const c: any = {};
    for (const m of ['values', 'returning']) c[m] = () => chain();
    c.then = (resolve: any, reject: any) => {
      const item = queue.length ? queue.shift() : [];
      if (item && (item as any).__throw) return Promise.reject((item as any).__throw).then(resolve, reject);
      return Promise.resolve(item).then(resolve, reject);
    };
    return c;
  };
  return {
    db: { insert: () => chain() },
    enqueue: (r: any) => queue.push(r),
    enqueueThrow: (e: any) => queue.push({ __throw: e }),
    reset: () => { queue.length = 0; },
  };
});

vi.mock('../src/db', () => ({ db: h.db }));
vi.mock('../src/services/logger', () => ({
  log: { info() {}, success() {}, warn() {}, error() {}, debug() {}, recent: () => [], clear() {} },
}));

import { signup } from '../src/controllers/auth.controller';

beforeEach(() => h.reset());

it('400s when email is missing', async () => {
  const res = mockRes();
  await signup(mockReq({ body: {} }), res);
  expect(res.statusCode).toBe(400);
});

it('creates a user and returns 201', async () => {
  h.enqueue([{ id: 'uuid-1', email: 'a@b.com' }]);
  const res = mockRes();
  await signup(mockReq({ body: { email: 'a@b.com' } }), res);
  expect(res.statusCode).toBe(201);
  expect(res.body.user.email).toBe('a@b.com');
});

it('409s on a duplicate email (unique violation 23505)', async () => {
  h.enqueueThrow({ code: '23505' });
  const res = mockRes();
  await signup(mockReq({ body: { email: 'a@b.com' } }), res);
  expect(res.statusCode).toBe(409);
});

it('500s on any other DB error', async () => {
  h.enqueueThrow(new Error('connection refused'));
  const res = mockRes();
  await signup(mockReq({ body: { email: 'a@b.com' } }), res);
  expect(res.statusCode).toBe(500);
});
