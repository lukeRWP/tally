const Joi = require('joi');

const queueSchema = Joi.object({
  itemId: Joi.number().integer().positive().required(),
  // A brand is what makes a search resolvable, so it is required here even
  // though the confidence half of the gate can only be applied client-side.
  brand: Joi.string().trim().max(255).required(),
  name: Joi.string().trim().max(255).required(),
  category: Joi.string().trim().max(100).allow(null, ''),
  description: Joi.string().trim().max(1000).allow(null, ''),
});

const listQuerySchema = Joi.object({
  propertyId: Joi.number().integer().positive().required(),
});

const resolveSchema = Joi.object({
  candidateIndex: Joi.number().integer().min(0).max(9),
  dismiss: Joi.boolean(),
}).xor('candidateIndex', 'dismiss');

module.exports = { queueSchema, listQuerySchema, resolveSchema };
