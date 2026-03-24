const Joi = require('joi');

const generateLabels = Joi.object({
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityIds: Joi.array().items(Joi.number().integer()).min(1).max(100).required(),
  format: Joi.string().valid('pdf', 'zpl').default('pdf'),
});

const resolveCode = Joi.object({
  code: Joi.string().pattern(/^TLY-[PACI]-[0-9A-Fa-f]{4}$/).required(),
});

module.exports = { generateLabels, resolveCode };
