/**
 * setu.service unit tests — Setu AA client with fetch mocked.
 *
 * The service caches the OAuth token in module scope, so each test re-imports a
 * fresh module instance via vi.resetModules() + dynamic import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV = {
  SETU_TOKEN_URL: 'https://setu.test/auth/token',
  SETU_CLIENT_ID: 'client-id',
  SETU_CLIENT_SECRET: 'client-secret',
  SETU_FIU_BASE_URL: 'https://fiu.test',
  SETU_PRODUCT_INSTANCE_ID: 'instance-1',
};

function jsonRes(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

const tokenResponse = jsonRes({ status: 200, success: true, data: { token: 'tok-1', expiresIn: 1800 } });

async function freshService() {
  vi.resetModules();
  return import('../src/services/setu.service');
}

beforeEach(() => {
  Object.assign(process.env, ENV);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

describe('createConsent', () => {
  it('authenticates, posts the consent, and returns id/url', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url === ENV.SETU_TOKEN_URL) return tokenResponse;
        if (url === `${ENV.SETU_FIU_BASE_URL}/v2/consents`) {
          return jsonRes({ id: 'consent-1', url: 'https://fiu.test/ui/consent-1', status: 'PENDING' }, 201);
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const svc = await freshService();
    const result = await svc.createConsent('9999999999');

    expect(result).toEqual({
      consentId: 'consent-1',
      consentUrl: 'https://fiu.test/ui/consent-1',
      status: 'PENDING',
    });

    // auth contract
    const tokenCall = calls.find((c) => c.url === ENV.SETU_TOKEN_URL)!;
    expect(JSON.parse(String(tokenCall.init.body))).toMatchObject({
      clientID: ENV.SETU_CLIENT_ID,
      secret: ENV.SETU_CLIENT_SECRET,
      grant_type: 'client_credentials',
    });

    // consent contract
    const consentCall = calls.find((c) => c.url.endsWith('/v2/consents'))!;
    const headers = consentCall.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
    expect(headers['x-product-instance-id']).toBe(ENV.SETU_PRODUCT_INSTANCE_ID);
    const body = JSON.parse(String(consentCall.init.body));
    expect(body.vua).toBe('9999999999@onemoney');
    expect(body.dataRange.from < body.dataRange.to).toBe(true);
  });

  it('reuses the cached token across calls', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === ENV.SETU_TOKEN_URL) return tokenResponse;
      return jsonRes({ id: 'c', url: 'u', status: 'PENDING' }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = await freshService();
    await svc.createConsent('9999999999');
    await svc.createConsent('8888888888');

    const tokenFetches = fetchMock.mock.calls.filter(([u]) => u === ENV.SETU_TOKEN_URL);
    expect(tokenFetches).toHaveLength(1);
  });

  it('throws a descriptive error when Setu rejects the consent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === ENV.SETU_TOKEN_URL) return tokenResponse;
        return jsonRes({ error: 'bad vua' }, 400);
      }),
    );
    const svc = await freshService();
    await expect(svc.createConsent('9999999999')).rejects.toThrow(/consent creation failed \(400\)/);
  });

  it('throws when required env config is missing', async () => {
    delete process.env.SETU_CLIENT_ID;
    vi.stubGlobal('fetch', vi.fn());
    const svc = await freshService();
    await expect(svc.createConsent('9999999999')).rejects.toThrow(/SETU_CLIENT_ID/);
  });
});

describe('getConsentStatus mapping', () => {
  it.each([
    ['ACTIVE', 'VERIFIED'],
    ['PENDING', 'PENDING'],
    ['REJECTED', 'FAILED'],
    ['EXPIRED', 'FAILED'],
    ['REVOKED', 'FAILED'],
    ['PAUSED', 'FAILED'],
    ['FAILED', 'FAILED'],
  ])('maps Setu %s → %s', async (raw, mapped) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === ENV.SETU_TOKEN_URL) return tokenResponse;
        return jsonRes({ id: 'consent-1', status: raw });
      }),
    );
    const svc = await freshService();
    const result = await svc.getConsentStatus('consent-1');
    expect(result).toEqual({ rawStatus: raw, mapped });
  });
});
