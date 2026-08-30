module.exports = function reportsRoutes({ app, db, logger, config }) {
  const ReportsService = require('./reports.service');
  ReportsService.init({ db, logger, config });

  const { generateReport, REPORT_TYPES, GROUP_BY } = require('./reports.schema');
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
      //
      // The header names the property and what was asked for, so a printed
      // report is self-describing once it leaves the screen that generated it.
      const scope = reportType === 'total_value' ? `by ${groupBy}`
        : reportType === 'activity_log' && (startDate || endDate)
          ? [startDate, endDate].filter(Boolean).join(' – ')
          : null;
      const propertyName = await ReportsService.getPropertyName(propertyId, req.user.id);
      const buffer = await ReportsService.generatePdf(reportType, data, { propertyName, scope });
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
      // Same vocabulary as the generate schema — a second copy is how the two
      // ends of a contract drift apart without anyone noticing.
      if (!REPORT_TYPES.includes(reportType)) {
        return error(res, 'Invalid report type', 400);
      }

      if (!req.propertyRole) {
        return error(res, 'Property not found or access denied', 403);
      }

      // The preview must answer the question Generate will answer, so it takes
      // the same grouping — and validates it against the same list. A groupBy
      // this route did not recognise used to fall through to `property`, so the
      // number beside Generate was quietly computed for a different report
      // (#310); silently substituting a grouping is what made that invisible.
      const groupBy = req.query.groupBy || 'property';
      if (!GROUP_BY.includes(groupBy)) {
        return error(res, 'Invalid groupBy', 400);
      }
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
