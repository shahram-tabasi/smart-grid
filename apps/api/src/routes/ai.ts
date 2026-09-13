import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/auth';
import { writeAuditLog } from '../middleware/audit';
import { answerChatQuestion, generateOrFetchRootCauseAnalysis } from '../services/simorghAi';

export const aiRouter = createRouter();

// Simorgh Grid Copilot chat (spec §28). Advisory only — see services/simorghAi.ts header.
aiRouter.post('/chat', requireAuth, async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  let sid = sessionId;
  if (!sid) {
    const { rows } = await pool.query(
      'INSERT INTO ai_chat_sessions (user_id, title) VALUES ($1, $2) RETURNING id',
      [req.user!.id, message.slice(0, 80)]
    );
    sid = rows[0].id;
  }

  await pool.query('INSERT INTO ai_chat_messages (session_id, role, content) VALUES ($1, $2, $3)', [sid, 'user', message]);
  const { answer, evidence } = await answerChatQuestion(message);
  await pool.query('INSERT INTO ai_chat_messages (session_id, role, content, evidence) VALUES ($1, $2, $3, $4)', [sid, 'assistant', answer, JSON.stringify(evidence)]);

  res.json({ sessionId: sid, answer, evidence });
});

aiRouter.get('/chat/:sessionId', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT role, content, evidence, created_at FROM ai_chat_messages WHERE session_id = $1 ORDER BY created_at',
    [req.params.sessionId]
  );
  res.json({ messages: rows });
});

// Simorgh Power Intelligence — root cause analysis for a fault (spec §10-11).
aiRouter.get('/analyses/fault/:faultId', async (req, res) => {
  const analysis = await generateOrFetchRootCauseAnalysis(req.params.faultId);
  if (!analysis) return res.status(404).json({ error: 'Fault not found' });
  res.json(analysis);
});

// Human-in-the-loop approval. Nothing in this codebase auto-applies an AI recommendation — see
// docs/ARCHITECTURE.md §8. Approving here only records the decision (and optionally links a work
// order that was separately created through the normal work-order workflow).
aiRouter.post('/analyses/:id/approve', requireAuth, requireRole('ADMIN', 'TECHNICAL_MANAGER', 'PROJECT_MANAGER', 'PROTECTION_ENGINEER'), async (req, res) => {
  const { decision, resultingWorkOrderId, notes } = req.body ?? {};
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ error: "decision must be 'APPROVED' or 'REJECTED'" });

  const { rows } = await pool.query(
    `INSERT INTO ai_recommendation_approvals (ai_analysis_id, decision, approved_by, resulting_work_order_id, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [req.params.id, decision, req.user!.id, resultingWorkOrderId ?? null, notes ?? null]
  );
  await writeAuditLog({ userId: req.user!.id, action: 'HUMAN_APPROVAL', entityType: 'AI_ANALYSIS', entityId: req.params.id, details: { decision }, ipAddress: req.ip });
  res.status(201).json(rows[0]);
});
