const Joi = require('joi');

// The types a user can opt into. Only these two have a producer
// (checkDateNotifications in the service); the other four the enum once
// advertised — warranty_expiry, item_moved, item_removed, share_expiring — were
// never created by anything, so their toggles were dead controls (#348). The DB
// enums deliberately still list them: a column ENUM is cheap to leave and
// expensive to shrink, and nothing writes those values.
const NOTIFICATION_TYPES = ['lending_due', 'custom_date'];

const queryNotifications = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  unreadOnly: Joi.boolean().default(false),
});

const updatePreference = Joi.object({
  type: Joi.string().valid(...NOTIFICATION_TYPES).required(),
  enabled: Joi.boolean().required(),
});

module.exports = { NOTIFICATION_TYPES, queryNotifications, updatePreference };
