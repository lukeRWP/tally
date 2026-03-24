const Joi = require('joi');

const createArea = Joi.object({
  name: Joi.string().max(255).required(),
  description: Joi.string().allow('', null),
  propertyId: Joi.number().integer().required(),
});

const updateArea = Joi.object({
  name: Joi.string().max(255),
  description: Joi.string().allow('', null),
}).min(1);

module.exports = { createArea, updateArea };
