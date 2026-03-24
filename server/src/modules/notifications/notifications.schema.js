const Joi = require('joi');

const queryNotifications = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
  unreadOnly: Joi.boolean().default(false),
});

const updatePreference = Joi.object({
  type: Joi.string().valid('warranty_expiry', 'lending_due', 'item_moved', 'item_removed', 'share_expiring', 'custom_date').required(),
  enabled: Joi.boolean().required(),
});

module.exports = { queryNotifications, updatePreference };
