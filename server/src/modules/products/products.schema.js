const Joi = require('joi');

const createProduct = Joi.object({
  barcode: Joi.string().max(50).required(),
  name: Joi.string().max(255).required(),
  brand: Joi.string().max(255).allow('', null),
  category: Joi.string().max(100).allow('', null),
  description: Joi.string().allow('', null),
  // https only (#355): a product row is shared by every household and its
  // image is rendered on the public share page — see products/image-url.js.
  imageUrl: Joi.string().uri({ scheme: ['https'] }).max(2000).allow('', null),
  retailPrice: Joi.number().precision(2).allow(null),
  // url restricted to http/https so a poisoned external-lookup response can't
  // persist a javascript:/data: link that later reaches an anchor href. The
  // client also guards at render (safeExternalUrl) for anything already stored.
  retailLinks: Joi.array().items(Joi.object({
    retailer: Joi.string(),
    url: Joi.string().uri({ scheme: ['http', 'https'] }).allow('', null),
    price: Joi.number().allow(null),
  })).allow(null),
  specs: Joi.object().allow(null),
  depreciationRate: Joi.number().precision(4).min(0).max(1).allow(null),
  dataSource: Joi.string().valid('upc_db', 'open_food_facts', 'scrape', 'manual').default('manual'),
});

const lookupBarcode = Joi.object({
  barcode: Joi.string().max(50).required(),
});

module.exports = { createProduct, lookupBarcode };
