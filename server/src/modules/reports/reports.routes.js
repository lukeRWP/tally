module.exports = function reportsRoutes({ app, db, logger, config }) {
  const ReportsService = require('./reports.service');
  ReportsService.init({ db, logger, config });

  const { generateReport } = require('./reports.schema');
  const { success, error } = require('../../utils/response');

  // ── Generate Report (PDF / CSV) ──────────────────────────────────────────

  // POST /api/reports/_y_/generate
  app.post(
    '/api/reports/_y_/generate',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      const { error: validationError, value } = generateReport.validate(req.body, { abortEarly: false, stripUnknown: true });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }

      if (!req.propertyRole) {
        return error(res, 'Property not found or access denied', 403);
      }

      const { reportType, propertyId, format, groupBy, tagIds, startDate, endDate, limit, offset } = value;

      let data;
      try {
        data = await ReportsService._fetchReportData(reportType, propertyId, { groupBy, tagIds, startDate, endDate, limit, offset });
      } catch (err) {
        logger.error('Failed to fetch report data', { reportType, propertyId, error: err.message });
        return error(res, 'Failed to generate report', 500);
      }

      if (format === 'csv') {
        const csv = ReportsService.generateCsv(reportType, data);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="tally-${reportType}-report.csv"`);
        return res.send(csv);
      }

      // Default: PDF
      const buffer = await ReportsService.generatePdf(reportType, data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="tally-${reportType}-report.pdf"`);
      return res.send(buffer);
    }
  );

  // ── Preview Report Data (JSON) ───────────────────────────────────────────

  // GET /api/reports/_x_/preview/:reportType/:propertyId
  app.get(
    '/api/reports/_x_/preview/:reportType/:propertyId',
    app.locals.requireAuth,
    app.locals.resolvePropertyRole,
    async (req, res) => {
      const { reportType, propertyId } = req.params;
      const validTypes = ['insurance', 'total_value', 'items_by_location', 'lending', 'activity_log', 'tag'];
      if (!validTypes.includes(reportType)) {
        return error(res, 'Invalid report type', 400);
      }

      if (!req.propertyRole) {
        return error(res, 'Property not found or access denied', 403);
      }

      const groupBy = req.query.groupBy || 'property';
      const tagIds = req.query.tagIds ? req.query.tagIds.split(',').map(Number).filter(n => !isNaN(n)) : null;
      const startDate = req.query.startDate || null;
      const endDate = req.query.endDate || null;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

      let data;
      try {
        data = await ReportsService._fetchReportData(reportType, propertyId, { groupBy, tagIds, startDate, endDate, limit, offset });
      } catch (err) {
        logger.error('Failed to fetch report preview', { reportType, propertyId, error: err.message });
        return error(res, 'Failed to fetch report data', 500);
      }

      success(res, { reportType, propertyId: Number(propertyId), data });
    }
  );
};
