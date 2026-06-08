import { Router } from 'express';
import { createIntent, getIntentStatus } from '../controllers/intent.controller';
import { authenticatePlatformKey } from '../middleware/auth.middleware';

const router = Router();

router.post('/create', authenticatePlatformKey, createIntent);
router.get('/status/:refId', authenticatePlatformKey, getIntentStatus);

export default router;
