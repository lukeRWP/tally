const Joi = require('joi');

const lendItem = Joi.object({
  lentTo: Joi.string().max(255).required(),
  dueAt: Joi.date().iso().allow(null),
  notes: Joi.string().allow('', null),
});

module.exports = { lendItem };
