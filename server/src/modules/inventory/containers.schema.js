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
});

module.exports = { createContainer, updateContainer, moveContainer };
