const Joi = require('joi');

const createSnapshot = Joi.object({
  condition: Joi.string().valid('new', 'good', 'fair', 'poor').required(),
  notes: Joi.string().allow('', null),
});

module.exports = { createSnapshot };
