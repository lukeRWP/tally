const Joi = require('joi');

// The three printable rolls. 'sheet' is deliberately absent: an Avery 5160
// 30-up Letter page is laser output and cannot be printed on a label roll.
const PRINTABLE_PRESETS = ['small', 'medium', 'large'];

const createJob = Joi.object({
  entityType: Joi.string().valid('item', 'container', 'area').required(),
  entityIds: Joi.array().items(Joi.number().integer()).min(1).max(100).required(),
  preset: Joi.string().valid(...PRINTABLE_PRESETS).required().messages({
    'any.only': 'Avery sheets are for a laser printer — use Download PDF instead',
  }),
});

const setLoadedMedia = Joi.object({
  loadedMedia: Joi.string().valid(...PRINTABLE_PRESETS).required(),
});

const createAgent = Joi.object({
  propertyId: Joi.number().integer().required(),
  name: Joi.string().trim().min(1).max(100).required(),
});

// Telemetry rides the claim request. A malformed or absent payload must never
// break the claim — it degrades to 'unknown' rather than erroring.
const agentClaim = Joi.object({
  printerState: Joi.string().valid('idle', 'printing', 'stopped', 'unknown').default('unknown'),
  printerStateReasons: Joi.array().items(Joi.string().max(64)).max(10).default([]),
});

const agentAck = Joi.object({
  ok: Joi.boolean().required(),
  error: Joi.string().max(500).allow('').optional(),
});

module.exports = { createJob, setLoadedMedia, createAgent, agentClaim, agentAck, PRINTABLE_PRESETS };
