const { error } = require('../utils/response');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error: validationError, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
    });
    if (validationError) {
      const errors = validationError.details.map(d => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return error(res, 'Validation failed', 400, errors);
    }
    // Express 5 makes req.query a prototype getter with no setter (v4→v5
    // migration guide, "req.query"), so `req.query = value` would be a silent
    // sloppy-mode no-op and the coerced/defaulted Joi value would never land.
    // Defining an own property shadows the getter; plain assignment keeps
    // working for body/params.
    if (source === 'query') {
      Object.defineProperty(req, 'query', { value, writable: true, configurable: true, enumerable: true });
    } else {
      req[source] = value;
    }
    next();
  };
}

module.exports = validate;
