import { Router } from 'express';
import { createConsentHandler, consentStatusHandler } from '../controllers/verification.controller';

const router = Router();

// Setu AA adapter — called directly by the UwU SDK from the browser.
router.post('/consent', createConsentHandler);
router.get('/status', consentStatusHandler);

export default router;
