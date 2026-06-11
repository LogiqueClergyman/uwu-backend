import { Router } from 'express';
import { generateKeys, listKeys, revokeKey, getStats } from '../controllers/dashboard.controller';
import { authenticatePlatformKey } from '../middleware/auth.middleware';

const router = Router();

router.post('/keys/generate', generateKeys);
router.get('/keys', listKeys);
router.post('/keys/revoke', revokeKey);
router.get('/stats', authenticatePlatformKey, getStats);

export default router;
