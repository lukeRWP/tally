const Joi = require('joi');

const uploadFile = Joi.object({
  fileType: Joi.string().valid('receipt', 'warranty', 'manual', 'photo', 'other').required(),
});

module.exports = { uploadFile };
