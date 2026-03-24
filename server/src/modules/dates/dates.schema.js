const Joi = require('joi');

const createDate = Joi.object({
  dateType: Joi.string().max(50).required(),
  dateValue: Joi.date().iso().required(),
  notes: Joi.string().allow('', null),
});

const updateDate = Joi.object({
  dateType: Joi.string().max(50),
  dateValue: Joi.date().iso(),
  notes: Joi.string().allow('', null),
}).min(1);

module.exports = { createDate, updateDate };
