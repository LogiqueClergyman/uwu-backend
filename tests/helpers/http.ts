import { vi } from 'vitest';

/**
 * Minimal Express Response double.
 * `status()` / `json()` are chainable (return `this`) and record what the
 * handler sent so tests can assert on `res.statusCode` / `res.body`.
 */
export function mockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.sendFile = vi.fn(() => res);
  return res;
}

/** Build a request double with the bits our handlers actually read. */
export function mockReq(init: Partial<{ body: any; params: any; query: any; headers: any }> = {}) {
  return {
    body: init.body ?? {},
    params: init.params ?? {},
    query: init.query ?? {},
    headers: init.headers ?? {},
  } as any;
}
