const multer = require('multer');

// Multer rejects by handing an Error to the route chain. An Error with no
// status reaches the global handler as a 500 — which is what a wrong MIME or
// an oversized body returned on the files and condition routes for as long as
// they existed. On iOS `accept="image/*"` hands the browser HEIC, so "add a
// photo" on an item page was a 500 for a whole class of phones (#346).
//
// vision.http.js had the mapping first; this is that, shared, so three routes
// cannot drift on what a rejected upload means.

/** The error a fileFilter should reject with: it carries its own status. */
function unsupportedType(message) {
  return Object.assign(new Error(message), { statusCode: 415 });
}

/**
 * Build a memory-storage multer that rejects anything outside `accepted`
 * with a 415, capped at `maxBytes`.
 */
function memoryUpload({ accepted, maxBytes, message = 'File type not allowed', limits = {} }) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, ...limits },
    fileFilter: (req, file, cb) => {
      if (accepted.has(file.mimetype)) return cb(null, true);
      cb(unsupportedType(message));
    },
  });
}

/**
 * `upload.single(field)` with every rejection mapped to a 4xx:
 *   415 from the fileFilter, 413 for LIMIT_FILE_SIZE, 400 for the rest
 *   (unexpected field, too many parts, malformed multipart).
 */
function single(upload, field) {
  return function uploadSingle(req, res, next) {
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') err.statusCode = 413;
      if (!err.statusCode) err.statusCode = 400;
      next(err);
    });
  };
}

module.exports = { memoryUpload, single, unsupportedType };
