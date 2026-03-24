const Joi = require('joi');

const linkAccessory = Joi.object({
  accessoryId: Joi.number().integer().required(),
});

module.exports = { linkAccessory };
