const crypto = require('crypto');

const TYPE_MAP = { P: 'property', A: 'area', C: 'container', I: 'item' };
const REVERSE_MAP = Object.fromEntries(Object.entries(TYPE_MAP).map(([k, v]) => [v, k]));

function generateCode(entityType) {
  const prefix = REVERSE_MAP[entityType];
  if (!prefix) throw new Error(`Unknown entity type: ${entityType}`);
  const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TLY-${prefix}-${hex}`;
}

function parseCode(code) {
  const match = code.match(/^TLY-([PACI])-([0-9A-Fa-f]{4,8})$/);
  if (!match) return null;
  return { type: TYPE_MAP[match[1]], hex: match[2].toUpperCase() };
}

module.exports = { generateCode, parseCode, TYPE_MAP };
