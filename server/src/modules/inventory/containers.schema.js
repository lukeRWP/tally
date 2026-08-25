const Joi = require('joi');

const createContainer = Joi.object({
  name: Joi.string().max(255).required(),
  type: Joi.string().max(50).required(),
  description: Joi.string().allow('', null),
  areaId: Joi.number().integer().required(),
  parentContainerId: Joi.number().integer().allow(null),
});

const updateContainer = Joi.object({
  name: Joi.string().max(255),
  type: Joi.string().max(50),
  description: Joi.string().allow('', null),
}).min(1);

const moveContainer = Joi.object({
  parentContainerId: Joi.number().integer().allow(null).required(),
  areaId: Joi.number().integer(),
  // Explicit opt-in for a cross-property move that would strand accessory
  // links (previewed via previewConsequences). Same-property moves never
  // look at this field.
  confirm: Joi.boolean(),
});

module.exports = { createContainer, updateContainer, moveContainer };
