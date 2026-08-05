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
}).custom((value, helpers) => {
  // Same rule Phase 1's labels.schema enforces: `large` is a contents manifest
  // of a container's or area's contents, so it is meaningless for an item.
  // Without this the render would run the area-manifest branch against an item
  // id and emit a nonsense label.
  if (value.preset === 'large' && value.entityType === 'item') {
    return helpers.message('preset "large" is a contents manifest — only valid for containers or areas');
  }
  return value;
}, 'large-requires-container-or-area');

const setLoadedMedia = Joi.object({
  loadedMedia: Joi.string().valid(...PRINTABLE_PRESETS).required(),
});

const createAgent = Joi.object({
  propertyId: Joi.number().integer().required(),
  name: Joi.string().trim().min(1).max(100).required(),
});

// Telemetry rides the claim request, so it must NEVER be able to break the
// claim. Rejecting a malformed payload would 400 the whole request and wedge
// that printer's queue over a cosmetic field — a bad agent build could stop
// printing entirely. Unrecognised values are therefore coerced to 'unknown'
// and junk reasons are dropped, rather than validated.
const PRINTER_STATES = ['idle', 'printing', 'stopped', 'unknown'];

const agentClaim = Joi.object({
  printerState: Joi.any()
    .custom(v => (PRINTER_STATES.includes(v) ? v : 'unknown'))
    .default('unknown'),
  printerStateReasons: Joi.any()
    .custom(v => (Array.isArray(v)
      ? v.filter(r => typeof r === 'string' && r.length <= 64).slice(0, 10)
      : []))
    .default([]),
});

const agentAck = Joi.object({
  ok: Joi.boolean().required(),
  error: Joi.string().max(500).allow('').optional(),
});

module.exports = { createJob, setLoadedMedia, createAgent, agentClaim, agentAck, PRINTABLE_PRESETS };
