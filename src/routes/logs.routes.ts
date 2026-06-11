import { Router } from 'express';
import { log } from '../services/logger';

const router = Router();

// JSON feed of recent backend activity (powers the /logs viewer). Optional
// ?category=KEYS|SETU|SIGN|... and ?limit=N filters.
router.get('/', (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 300);
  const category = (req.query.category as string | undefined) || undefined;
  const logs = log.recent(limit, category);
  res.json({ count: logs.length, logs });
});

router.post('/clear', (_req, res) => {
  log.clear();
  res.json({ ok: true });
});

export default router;
