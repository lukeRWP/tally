module.exports = function printRoutes({ app, db, logger, config }) {
  const PrintService = require('./print.service');
  PrintService.init({ db, logger, config });

  const { requireAgent } = require('./agent.middleware');
  const { createJob, setLoadedMedia, createAgent, agentClaim, agentAck } = require('./print.schema');
  const validate = require('../../middleware/validate');
  const { success, error } = require('../../utils/response');

  const { requireAuth } = app.locals;
  const agentAuth = requireAgent({ db });

  // ── User endpoints (session auth) ─────────────────────────────────────────

  // ── POST /api/print/_y_/jobs — queue a print ──────────────────────────────
  app.post('/api/print/_y_/jobs', requireAuth, validate(createJob, 'body'), async (req, res) => {
    const { entityType, entityIds, preset } = req.body;
    const out = await PrintService.createJob({ entityType, entityIds, preset, userId: req.user.id });
    if (out.error === 'not_found') return error(res, 'No entities found for the given IDs', 404);
    if (out.error === 'mixed') return error(res, 'All labels in one job must belong to the same property', 400);
    return success(res, out);
  });

  // ── GET /api/print/_x_/jobs — the queue for a property ────────────────────
  app.get('/api/print/_x_/jobs', requireAuth, async (req, res) => {
    const propertyId = Number(req.query.propertyId);
    if (!propertyId) return error(res, 'propertyId is required', 400);
    return success(res, await PrintService.listJobs(propertyId, req.user.id, 50));
  });

  // ── PATCH /api/print/_p_/jobs/:id/cancel ──────────────────────────────────
  app.patch('/api/print/_p_/jobs/:id/cancel', requireAuth, async (req, res) => {
    const ok = await PrintService.cancelJob(Number(req.params.id), req.user.id);
    return ok ? success(res, { canceled: true }) : error(res, 'Job not found or already finished', 404);
  });

  // ── POST /api/print/_y_/jobs/:id/retry ────────────────────────────────────
  app.post('/api/print/_y_/jobs/:id/retry', requireAuth, async (req, res) => {
    const ok = await PrintService.retryJob(Number(req.params.id), req.user.id);
    return ok ? success(res, { requeued: true }) : error(res, 'Job not found or not in a failed state', 404);
  });

  // ── POST /api/print/_y_/agents — register a printer ───────────────────────
  app.post('/api/print/_y_/agents', requireAuth, validate(createAgent, 'body'), async (req, res) => {
    const out = await PrintService.createAgent({
      propertyId: req.body.propertyId, name: req.body.name, userId: req.user.id,
    });
    if (out.error) return error(res, 'Property not found', 404);
    // The plaintext token appears in this response and nowhere else, ever.
    return success(res, out, 'Copy this token now — it will not be shown again');
  });

  // ── GET /api/print/_x_/agents ─────────────────────────────────────────────
  app.get('/api/print/_x_/agents', requireAuth, async (req, res) => {
    const propertyId = Number(req.query.propertyId);
    if (!propertyId) return error(res, 'propertyId is required', 400);
    return success(res, await PrintService.listAgents(propertyId, req.user.id));
  });

  // ── DELETE /api/print/_d_/agents/:id ──────────────────────────────────────
  app.delete('/api/print/_d_/agents/:id', requireAuth, async (req, res) => {
    const ok = await PrintService.revokeAgent(Number(req.params.id), req.user.id);
    return ok ? success(res, { revoked: true }) : error(res, 'Printer not found', 404);
  });

  // ── PUT /api/print/_u_/agents/:id/loaded-media ────────────────────────────
  app.put('/api/print/_u_/agents/:id/loaded-media', requireAuth, validate(setLoadedMedia, 'body'), async (req, res) => {
    const out = await PrintService.setLoadedMedia(Number(req.params.id), req.body.loadedMedia, req.user.id);
    return out ? success(res, out) : error(res, 'Printer not found', 404);
  });

  // ── Agent endpoints (bearer token; no session, no CSRF) ───────────────────

  // ── POST /api/print/_y_/agent/claim ───────────────────────────────────────
  app.post('/api/print/_y_/agent/claim', agentAuth, validate(agentClaim, 'body'), async (req, res) => {
    const job = await PrintService.claimNext(req.agent, req.body);
    if (!job) return res.status(204).end();   // idle — nothing to print
    return success(res, job);
  });

  // ── GET /api/print/_x_/agent/jobs/:id/pdf ─────────────────────────────────
  app.get('/api/print/_x_/agent/jobs/:id/pdf', agentAuth, async (req, res) => {
    // Only a job this agent currently holds — never an arbitrary id.
    const job = await PrintService.getClaimedJob(Number(req.params.id), req.agent.id);
    if (!job) return error(res, 'Job not found or not claimed by this agent', 404);

    const pdf = await PrintService.renderJobPdf(job);
    if (!pdf) return error(res, 'Nothing to render for this job', 404);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="job-${job.id}.pdf"`);
    return res.send(pdf);
  });

  // ── POST /api/print/_y_/agent/jobs/:id/ack ────────────────────────────────
  app.post('/api/print/_y_/agent/jobs/:id/ack', agentAuth, validate(agentAck, 'body'), async (req, res) => {
    const status = await PrintService.ackJob(
      Number(req.params.id), req.agent.id, req.body.ok, req.body.error
    );
    return status ? success(res, { status }) : error(res, 'Job not found or not claimed by this agent', 404);
  });
};
