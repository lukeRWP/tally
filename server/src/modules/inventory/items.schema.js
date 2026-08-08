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
  tagIds: Joi.array().items(Joi.number().integer()).allow(null),
});

// Home shows everything the caller can see, so there is nothing to filter by —
// only how much of it to show. A property filter here would be dead weight, the
// way searchItems.propertyId is: validated and read by nobody.
const recentItems = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(25),
});

module.exports = { createItem, updateItem, moveItem, searchItems, recentItems };
