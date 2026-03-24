const Joi = require('joi');

const createShareLink = Joi.object({
  entityType: Joi.string().valid('property', 'area', 'container', 'item').required(),
  entityId: Joi.number().integer().required(),
  expiresInDays: Joi.number().integer().min(1).max(90).default(7),
});

module.exports = { createShareLink };
