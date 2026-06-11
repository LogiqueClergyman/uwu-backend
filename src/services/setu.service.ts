import 'dotenv/config';

/**
 * Setu Account Aggregator (AA) client.
 *
 * Setu AA is a server-to-server, OAuth-authenticated API: it cannot be called
 * from the browser (CORS + the client secret must never reach the client). The
 * UwU SDK therefore calls this backend's `/api/verification/*` adapter, which
 * holds the Setu app credentials and proxies to Setu's sandbox.
 *
 * Contract verified live against fiu-sandbox.setu.co:
 *   POST {SETU_TOKEN_URL}                 { clientID, secret, grant_type } -> { data: { token, expiresIn } }
 *   POST {SETU_FIU_BASE_URL}/v2/consents  (Bearer + x-product-instance-id) -> 201 { id, url, status, detail }
 *   GET  {SETU_FIU_BASE_URL}/v2/consents/{id}                              -> 200 { id, url, status, detail, ... }
 *
 * Consent `status` enum: PENDING | ACTIVE | REJECTED | EXPIRED | REVOKED | PAUSED | FAILED.
 *
 * NOTE (multi-tenant): the per-merchant Setu key arrives from the SDK as `setuKey`
 * (the `api_keys.setu_api_key` value). For this single-app sandbox setup the real
 * Setu credentials live in env; to support many merchants, map `setuKey` to that
 * merchant's own client id/secret/instance here instead of reading env.
 */

import { log } from './logger';

const TIMEOUT_MS = 15_000;

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Setu config missing: ${key} is not set in the environment.`);
  return v;
}

function fiuHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'x-product-instance-id': env('SETU_PRODUCT_INSTANCE_ID'),
  };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  // Reuse the token until it is within 60s of expiry.
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    log.debug('SETU', 'Reusing cached Setu auth token');
    return cachedToken.token;
  }

  log.info('SETU', 'Fetching Setu auth token (POST auth/token)');
  const resp = await fetch(env('SETU_TOKEN_URL'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientID: env('SETU_CLIENT_ID'),
      secret: env('SETU_CLIENT_SECRET'),
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    log.error('SETU', `Setu auth failed (${resp.status})`, { detail: detail.slice(0, 200) });
    throw new Error(`Setu auth failed (${resp.status}): ${detail}`);
  }
  const json: any = await resp.json();
  const token: string | undefined = json?.data?.token;
  const expiresIn = Number(json?.data?.expiresIn) || 1800;
  if (!token) throw new Error('Setu auth returned no token');
  cachedToken = { token, expiresAt: now + expiresIn * 1000 };
  log.success('SETU', 'Setu auth token acquired', { expiresIn });
  return token;
}

export interface CreatedConsent {
  consentId: string;
  consentUrl: string;
  status: string;
}

/**
 * Create an AA consent request for the buyer's phone number.
 * Consent type / FI types / purpose are configured on the Setu product instance,
 * so they need not be sent here.
 */
export async function createConsent(phoneNumber: string): Promise<CreatedConsent> {
  const token = await getToken();
  const base = env('SETU_FIU_BASE_URL');
  const aaHandle = process.env.SETU_AA_HANDLE || 'onemoney';
  const redirectUrl = process.env.SETU_CONSENT_REDIRECT_URL || 'http://localhost:3000/uwu-aa-redirect';

  const now = new Date();
  const from = new Date(now.getTime() - 365 * 24 * 3600 * 1000);

  const body = {
    consentDuration: { unit: 'MONTH', value: '1' },
    vua: `${phoneNumber}@${aaHandle}`,
    dataRange: { from: from.toISOString(), to: now.toISOString() },
    context: [] as unknown[],
    redirectUrl,
  };

  log.info('SETU', 'Creating AA consent (POST /v2/consents)', { vua: body.vua, redirectUrl });
  const resp = await fetch(`${base}/v2/consents`, {
    method: 'POST',
    headers: fiuHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    log.error('SETU', `Consent creation failed (${resp.status})`, { detail: detail.slice(0, 200) });
    throw new Error(`Setu consent creation failed (${resp.status}): ${detail}`);
  }
  const json: any = await resp.json();
  if (!json?.id || !json?.url) throw new Error('Setu consent response missing id/url');
  log.success('SETU', 'Consent created', { consentId: json.id, status: json.status || 'PENDING' });
  return { consentId: json.id, consentUrl: json.url, status: json.status || 'PENDING' };
}

export type MappedConsentStatus = 'VERIFIED' | 'FAILED' | 'PENDING';

export async function getConsentStatus(consentId: string): Promise<{ rawStatus: string; mapped: MappedConsentStatus }> {
  const token = await getToken();
  const base = env('SETU_FIU_BASE_URL');

  log.debug('SETU', 'Fetching consent status (GET /v2/consents/:id)', { consentId });
  const resp = await fetch(`${base}/v2/consents/${encodeURIComponent(consentId)}`, {
    method: 'GET',
    headers: fiuHeaders(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    log.error('SETU', `Consent status failed (${resp.status})`, { consentId, detail: detail.slice(0, 200) });
    throw new Error(`Setu consent status failed (${resp.status}): ${detail}`);
  }
  const json: any = await resp.json();
  const raw = String(json?.status || 'PENDING').toUpperCase();

  let mapped: MappedConsentStatus = 'PENDING';
  if (raw === 'ACTIVE') mapped = 'VERIFIED';
  else if (['REJECTED', 'EXPIRED', 'REVOKED', 'FAILED', 'PAUSED'].includes(raw)) mapped = 'FAILED';

  log.info('SETU', 'Consent status fetched', { consentId, rawStatus: raw, mapped });
  return { rawStatus: raw, mapped };
}
