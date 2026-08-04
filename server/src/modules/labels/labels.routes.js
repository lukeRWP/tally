module.exports = function labelsRoutes({ app, db, logger, config }) {
  const LabelsService = require('./labels.service');
  LabelsService.init({ db, logger, config });

  const { generateLabels, resolveCode } = require('./labels.schema');
  const validate = require('../../middleware/validate');
  const { success, error } = require('../../utils/response');

  // ── POST /api/labels/_y_/generate — generate labels (PDF, dispatch on preset)

  app.post(
    '/api/labels/_y_/generate',
    app.locals.requireAuth,
    validate(generateLabels, 'body'),
    async (req, res) => {
      const { entityType, entityIds, preset } = req.body;

      const sendPdf = (buf) => {
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'attachment; filename="tally-labels.pdf"');
        res.send(buf);
      };

      // Large = one contents manifest per selected container/area.
      if (preset === 'large') {
        const manifests = [];
        for (const id of entityIds) {
          const m = await LabelsService.getManifest(entityType, id, req.user.id);
          if (m) manifests.push(m);
        }
        if (manifests.length === 0) return error(res, 'No entities found for the given IDs', 404);
        return sendPdf(await LabelsService.renderManifestBundle(manifests, 'large'));
      }

      const entities = await LabelsService.getEntityData(entityType, entityIds, req.user.id);
      if (entities.length === 0) return error(res, 'No entities found for the given IDs', 404);

      if (preset === 'sheet') {
        const labelTypeMap = { item: 'asset', container: 'bin', area: 'location' };
        return sendPdf(await LabelsService.generatePdf(entities, labelTypeMap[entityType] || 'asset'));
      }

      // small / medium
      return sendPdf(await LabelsService.renderLabelPdf(entities, preset));
    }
  );

  // ── GET /api/labels/_x_/resolve/:code — resolve TLY code ────────────────

  app.get(
    '/api/labels/_x_/resolve/:code',
    app.locals.requireAuth,
    validate(resolveCode, 'params'),
    async (req, res) => {
      const result = await LabelsService.resolveCode(req.params.code, req.user.id);
      success(res, result);
    }
  );

  // ── GET /api/labels/_x_/qr/:code — generate QR code image (no auth — public QR images)

  app.get(
    '/api/labels/_x_/qr/:code',
    validate(resolveCode, 'params'),
    async (req, res) => {
      const buffer = await LabelsService.generateQrBuffer(req.params.code);
      res.set('Content-Type', 'image/png');
      res.send(buffer);
    }
  );
};
