const Joi = require('joi');
const { CATEGORY_ENUM } = require('../products/lookup/vision-identify');

// Mirrors the items.COMPLETENESS enum (migration 006). Exported so the reports
// layer decides what to exclude from a total by name rather than by literal.
const COMPLETENESS = ['complete', 'box_only', 'accessories_only'];
/** The values that mean "the thing itself is not here" — excluded from value totals. */
const PARTIAL = COMPLETENESS.filter(c => c !== 'complete');

const createItem = Joi.object({
  name: Joi.string().max(255).required(),
  description: Joi.string().allow('', null),
  containerId: Joi.number().integer().required(),
  productId: Joi.number().integer().allow(null),
  quantity: Joi.number().integer().min(1).default(1),
  purchasePrice: Joi.number().precision(2).allow(null),
  // The column existed and create() never wrote to it. Bounded here as well as
  // in the vision layer, because this is an ordinary authenticated endpoint —
  // the model's own filtering cannot be the only gate on a value that
  // reports.service.js reads into the insurance report.
  currentValue: Joi.number().precision(2).positive().max(100000).allow(null),
  // Set by the capture flow when the user Keeps the model's estimate. Defaults
  // to false, so every other caller writes a declared value without opting in —
  // the risky direction (a guess passing as declared) needs the explicit flag.
  currentValueIsEstimate: Joi.boolean().default(false),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor').default('good'),
  // Whether the thing itself is here, or only its packaging/spares. Scanning a
  // retail box otherwise files the product's full price against an empty box.
  completeness: Joi.string().valid(...COMPLETENESS).default('complete'),
  // Not a column on items — it is applied as a property-scoped tag after the
  // row is written (see items.routes.js). The closed enum is the gate: this is
  // an ordinary authenticated endpoint, reachable without ever calling the
  // vision route, so the model's own filtering cannot be the only check. Every
  // value is far under the tags.NAME VARCHAR(50) limit, which under
  // STRICT_TRANS_TABLES would error the insert rather than truncate.
  category: Joi.string().valid(...CATEGORY_ENUM).optional(),
});

const updateItem = Joi.object({
  name: Joi.string().max(255),
  description: Joi.string().allow('', null),
  quantity: Joi.number().integer().min(1),
  purchasePrice: Joi.number().precision(2).allow(null),
  // create() wrote CURRENT_VALUE and update() had no branch for it, so a value
  // could be set once and never corrected — including one the AI estimated.
  // Marking a number as a guess is only useful if there is a way to replace it.
  // Same bounds as create: this reaches the insurance report either way.
  currentValue: Joi.number().precision(2).positive().max(100000).allow(null),
  condition: Joi.string().valid('new', 'good', 'fair', 'poor'),
  completeness: Joi.string().valid(...COMPLETENESS),
  depreciationEnabled: Joi.boolean(),
  depreciationRate: Joi.number().precision(4).min(0).max(1).allow(null),
}).min(1);

const moveItem = Joi.object({
  containerId: Joi.number().integer().required(),
  // Explicit opt-in for a cross-property move that would strand accessory
  // links (previewed via previewConsequences). Same-property moves never
  // look at this field.
  confirm: Joi.boolean(),
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

module.exports = { createItem, updateItem, moveItem, searchItems, recentItems, COMPLETENESS, PARTIAL };
