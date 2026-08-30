const Joi = require('joi');
const { CATEGORIES } = require('./sharing.disclosure');

// The toggleable categories, straight off the catalogue — a key added there is
// accepted here without a second edit, and a key that is not a real category is
// rejected rather than silently stored as a choice that does nothing.
const OPTIONAL_KEYS = CATEGORIES.filter(c => c.optional).map(c => c.key);

const disclosureChoice = Joi.object(
  Object.fromEntries(OPTIONAL_KEYS.map(k => [k, Joi.boolean()]))
);

const createShareLink = Joi.object({
  entityType: Joi.string().valid('property', 'area', 'container', 'item').required(),
  entityId: Joi.number().integer().required(),
  expiresInDays: Joi.number().integer().min(1).max(90).default(7),
  // Optional on purpose: a client that sends nothing gets today's behaviour,
  // which is every category on. There is no default to state here.
  disclosure: disclosureChoice,
});

module.exports = { createShareLink };
