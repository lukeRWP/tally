const Joi = require('joi');

const createTag = Joi.object({
  name: Joi.string().max(50).required(),
  color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).required(),
  propertyId: Joi.number().integer().required(),
});

const updateTag = Joi.object({
  name: Joi.string().max(50),
  color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/),
}).min(1);

const tagEntity = Joi.object({
  tagId: Joi.number().integer().required(),
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityId: Joi.number().integer().required(),
});

module.exports = { createTag, updateTag, tagEntity };
