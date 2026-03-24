const Joi = require('joi');

const queryLog = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  entityType: Joi.string().valid('property', 'area', 'container', 'item'),
  action: Joi.string().valid('created', 'updated', 'moved', 'deleted', 'restored', 'lent', 'returned'),
});

module.exports = { queryLog };
