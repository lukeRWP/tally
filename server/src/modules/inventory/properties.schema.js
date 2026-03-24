const Joi = require('joi');

const createProperty = Joi.object({
  name: Joi.string().max(255).required(),
  address: Joi.string().allow('', null),
  description: Joi.string().allow('', null),
});

const updateProperty = Joi.object({
  name: Joi.string().max(255),
  address: Joi.string().allow('', null),
  description: Joi.string().allow('', null),
}).min(1);

const addMember = Joi.object({
  email: Joi.string().email().required(),
  role: Joi.string().valid('editor', 'viewer').required(),
});

const updateMemberRole = Joi.object({
  role: Joi.string().valid('owner', 'editor', 'viewer').required(),
});

module.exports = { createProperty, updateProperty, addMember, updateMemberRole };
