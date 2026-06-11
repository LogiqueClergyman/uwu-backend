/**
 * verification.controller unit tests — the SDK-facing Setu consent adapter.
 * The setu.service is mocked; we assert the HTTP contract + status codes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockReq, mockRes } from './helpers/http';

const svc = vi.hoisted(() => ({
  createConsent: vi.fn(),
  getConsentStatus: vi.fn(),
}));

vi.mock('../src/services/setu.service', () => svc);
vi.mock('../src/services/logger', () => ({
  log: { info() {}, success() {}, warn() {}, error() {}, debug() {}, recent: () => [], clear() {} },
}));

import { createConsentHandler, consentStatusHandler } from '../src/controllers/verification.controller';

beforeEach(() => {
  svc.createConsent.mockReset();
  svc.getConsentStatus.mockReset();
});

describe('createConsentHandler', () => {
  it('400s on an invalid phone number', async () => {
    const res = mockRes();
    await createConsentHandler(mockReq({ body: { phoneNumber: '123' } }), res);
    expect(res.statusCode).toBe(400);
    expect(svc.createConsent).not.toHaveBeenCalled();
  });

  it('issues a consent for a valid 10-digit number', async () => {
    svc.createConsent.mockResolvedValue({ consentId: 'c1', consentUrl: 'https://setu/c1', status: 'PENDING' });
    const res = mockRes();
    await createConsentHandler(mockReq({ body: { phoneNumber: '9999999999', tradeId: 'T1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ consentId: 'c1', consentUrl: 'https://setu/c1' });
    expect(svc.createConsent).toHaveBeenCalledWith('9999999999');
  });

  it('502s when Setu fails', async () => {
    svc.createConsent.mockRejectedValue(new Error('setu down'));
    const res = mockRes();
    await createConsentHandler(mockReq({ body: { phoneNumber: '9999999999' } }), res);
    expect(res.statusCode).toBe(502);
  });
});

describe('consentStatusHandler', () => {
  it('400s when consentId is missing', async () => {
    const res = mockRes();
    await consentStatusHandler(mockReq({ query: {} }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns the mapped + raw status', async () => {
    svc.getConsentStatus.mockResolvedValue({ rawStatus: 'ACTIVE', mapped: 'VERIFIED' });
    const res = mockRes();
    await consentStatusHandler(mockReq({ query: { consentId: 'c1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'VERIFIED', setuStatus: 'ACTIVE' });
  });

  it('502s when the status check throws', async () => {
    svc.getConsentStatus.mockRejectedValue(new Error('timeout'));
    const res = mockRes();
    await consentStatusHandler(mockReq({ query: { consentId: 'c1' } }), res);
    expect(res.statusCode).toBe(502);
  });
});
