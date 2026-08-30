const Joi = require('joi');

// The report vocabulary, in one place.
//
// These strings are the service's own keys — `_fetchReportData`'s switch, the
// `renderers` map, `REPORT_NAMES` and `generateCsv`'s switch are all indexed by
// them, so they are what a report IS, not a label chosen for the wire. They were
// duplicated as a literal array in the preview route and re-spelled with hyphens
// on the client, which meant four of the six report types 422'd on Generate and
// had never once worked (#263). Nothing persists a report type — no column, no
// saved configuration — so this list is the only definition there is.
const REPORT_TYPES = Object.freeze([
  'insurance',
  'total_value',
  'items_by_location',
  'lending',
  'activity_log',
  'tag',
]);

/** How `total_value` aggregates. `property` is a single grand total. */
const GROUP_BY = Object.freeze(['property', 'area', 'tag']);

const generateReport = Joi.object({
  reportType: Joi.string().valid(...REPORT_TYPES).required(),
  propertyId: Joi.number().integer().required(),
  format: Joi.string().valid('pdf', 'csv').default('pdf'),
  groupBy: Joi.string().valid(...GROUP_BY).default('property'),
  tagIds: Joi.array().items(Joi.number().integer()).allow(null),
  startDate: Joi.date().iso().allow(null),
  endDate: Joi.date().iso().allow(null),
  limit: Joi.number().integer().min(1).max(1000).default(500),
  offset: Joi.number().integer().min(0).default(0),
});

module.exports = { generateReport, REPORT_TYPES, GROUP_BY };
