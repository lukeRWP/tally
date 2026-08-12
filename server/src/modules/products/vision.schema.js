const Joi = require('joi');

/**
 * The photo rides in the multipart file part, so there is nothing to validate
 * here except the absence of everything else: a closed, empty set of text
 * fields, so a field added to the form later cannot be read and forwarded to a
 * language model before anyone has decided what it means.
 */
const identifyPhoto = Joi.object({}).unknown(false);

module.exports = { identifyPhoto };
