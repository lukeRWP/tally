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
    req[source] = value;
    next();
  };
}

module.exports = validate;
