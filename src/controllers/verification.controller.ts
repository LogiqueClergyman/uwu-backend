import { Request, Response } from 'express';
import { createConsent, getConsentStatus } from '../services/setu.service';
import { log } from '../services/logger';

/**
 * POST /api/verification/consent
 * Called directly by the UwU SDK (browser) with the per-intent `setuKey`.
 * Body: { setuKey, tradeId, inrAmountPaisa, payerId, payeeId, phoneNumber }
 * Returns: { consentId, consentUrl }
 */
export const createConsentHandler = async (req: Request, res: Response) => {
  try {
    const { phoneNumber, setuKey, tradeId } = req.body || {};

    if (!phoneNumber || !/^\d{10}$/.test(String(phoneNumber))) {
      return res.status(400).json({ error: 'A valid 10-digit phoneNumber is required' });
    }

    log.info('SETU', 'SDK requested consent', { tradeId: tradeId || 'n/a', setuKey: setuKey ? 'present' : 'absent' });
    const result = await createConsent(String(phoneNumber));
    log.success('SETU', 'Consent issued to SDK', { consentId: result.consentId, tradeId: tradeId || 'n/a' });
    return res.status(200).json({ consentId: result.consentId, consentUrl: result.consentUrl });
  } catch (err: any) {
    log.error('SETU', 'Consent creation error', { error: err?.message || String(err) });
    return res.status(502).json({ error: 'Setu consent creation failed', details: err?.message });
  }
};

/**
 * GET /api/verification/status?consentId=...
 * Returns: { status: "VERIFIED" | "FAILED" | "PENDING", setuStatus }
 * The SDK polls this and advances on "VERIFIED" (or aborts on "FAILED").
 */
export const consentStatusHandler = async (req: Request, res: Response) => {
  try {
    const consentId = req.query.consentId as string | undefined;
    if (!consentId) return res.status(400).json({ error: 'consentId query param is required' });

    const { rawStatus, mapped } = await getConsentStatus(consentId);
    return res.status(200).json({ status: mapped, setuStatus: rawStatus });
  } catch (err: any) {
    log.error('SETU', 'Consent status error', { error: err?.message || String(err) });
    return res.status(502).json({ error: 'Setu consent status check failed', details: err?.message });
  }
};
