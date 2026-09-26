const Joi = require('joi');

// Matches pwiam's own CONTROL_OR_FORMAT_RE gate on displayName/invitedBy.name
// (plan "Contract → pwiam"), so a name tally accepts here never gets rejected
// a step later with no context for the caller: no C0/C1 controls, no
// zero-width or BOM characters.
// eslint-disable-next-line no-control-regex -- the whole point is to catch these
const CONTROL_OR_FORMAT_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/;

const createInvite = Joi.object({
  displayName: Joi.string().trim().min(1).max(120)
    .pattern(CONTROL_OR_FORMAT_RE, { invert: true })
    .required(),
  role: Joi.string().valid('editor', 'viewer').required(),
});

module.exports = { createInvite };
