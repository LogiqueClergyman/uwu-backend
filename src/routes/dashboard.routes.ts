import { Router } from 'express';
import { generateKeys, getStats } from '../controllers/dashboard.controller';
import { authenticatePlatformKey } from '../middleware/auth.middleware';

const router = Router();

router.post('/keys/generate', generateKeys);
router.get('/stats', authenticatePlatformKey, getStats);

export default router;
