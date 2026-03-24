const Joi = require('joi');

const generateReport = Joi.object({
  reportType: Joi.string().valid('insurance', 'total_value', 'items_by_location', 'lending', 'activity_log', 'tag').required(),
  propertyId: Joi.number().integer().required(),
  format: Joi.string().valid('pdf', 'csv').default('pdf'),
  groupBy: Joi.string().valid('property', 'area', 'tag').default('property'),
  tagIds: Joi.array().items(Joi.number().integer()).allow(null),
  startDate: Joi.date().iso().allow(null),
  endDate: Joi.date().iso().allow(null),
  limit: Joi.number().integer().min(1).max(1000).default(500),
  offset: Joi.number().integer().min(0).default(0),
});

module.exports = { generateReport };
