const Joi = require('joi');

const generateLabels = Joi.object({
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityIds: Joi.array().items(Joi.number().integer()).min(1).max(100).required(),
  preset: Joi.string().valid('small', 'medium', 'large', 'sheet').default('small'),
}).custom((value, helpers) => {
  // Large is a contents manifest — only meaningful for a container or area.
  if (value.preset === 'large' && value.entityType === 'item') {
    return helpers.message('preset "large" is only valid for containers or areas');
  }
  return value;
}, 'large-requires-container-or-area');

const resolveCode = Joi.object({
  code: Joi.string().pattern(/^TLY-[PACI]-[0-9A-Fa-f]{4,8}$/).required(),
});

module.exports = { generateLabels, resolveCode };
