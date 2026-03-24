module.exports = function labelsRoutes({ app, db, logger, config }) {
  const LabelsService = require('./labels.service');
  LabelsService.init({ db, logger, config });

  const { generateLabels, resolveCode } = require('./labels.schema');
  const validate = require('../../middleware/validate');
  const { success, error } = require('../../utils/response');

  // ── POST /api/labels/_y_/generate — generate labels (PDF or ZPL) ─────────

  app.post(
    '/api/labels/_y_/generate',
    app.locals.requireAuth,
    validate(generateLabels, 'body'),
    async (req, res) => {
      const { entityType, entityIds, format } = req.body;

      const entities = await LabelsService.getEntityData(entityType, entityIds);
      if (entities.length === 0) {
        return error(res, 'No entities found for the given IDs', 404);
      }

      if (format === 'zpl') {
        const zpl = LabelsService.generateZpl(entities);
        return success(res, { zpl });
      }

      // Default: PDF
      const labelTypeMap = { item: 'asset', container: 'bin', area: 'location' };
      const labelType = labelTypeMap[entityType] || 'asset';
      const pdfBuffer = await LabelsService.generatePdf(entities, labelType);

      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="tally-labels.pdf"');
      res.send(pdfBuffer);
    }
  );

  // ── GET /api/labels/_x_/resolve/:code — resolve TLY code ────────────────

  app.get(
    '/api/labels/_x_/resolve/:code',
    app.locals.requireAuth,
    validate(resolveCode, 'params'),
    async (req, res) => {
      const result = await LabelsService.resolveCode(req.params.code);
      success(res, result);
    }
  );

  // ── GET /api/labels/_x_/qr/:code — generate QR code image ───────────────

  app.get(
    '/api/labels/_x_/qr/:code',
    app.locals.requireAuth,
    validate(resolveCode, 'params'),
    async (req, res) => {
      const buffer = await LabelsService.generateQrBuffer(req.params.code);
      res.set('Content-Type', 'image/png');
      res.send(buffer);
    }
  );
};
