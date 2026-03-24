const Joi = require('joi');

const createItem = Joi.object({
  name: Joi.string().max(255).required(),
  description: Joi.string().allow('', null),
  containerId: Joi.number().integer().required(),
  productId: Joi.number().integer().allow(null),
  quantity: Joi.number().integer().min(1).default(1),
  purchasePrice: Joi.number().precision(2).allow(null),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor').default('good'),
});

const updateItem = Joi.object({
  name: Joi.string().max(255),
  description: Joi.string().allow('', null),
  quantity: Joi.number().integer().min(1),
  purchasePrice: Joi.number().precision(2).allow(null),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor'),
  depreciationEnabled: Joi.boolean(),
  depreciationRate: Joi.number().precision(4).min(0).max(1).allow(null),
}).min(1);

const moveItem = Joi.object({
  containerId: Joi.number().integer().required(),
});

const searchItems = Joi.object({
  q: Joi.string().min(1).max(255).required(),
  propertyId: Joi.number().integer(),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor'),
  status: Joi.string().valid('active', 'removed', 'lent'),
});

module.exports = { createItem, updateItem, moveItem, searchItems };
