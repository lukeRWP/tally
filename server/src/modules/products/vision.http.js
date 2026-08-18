const multer = require('multer');
const { sniffMime } = require('../../utils/fileType');
const { success, error } = require('../../utils/response');
const { identifyPhoto } = require('./vision.schema');

// Nothing here is kept, so a bigger image only costs more to look at. 6MB is
// ~12x the client's typical 200-500KB and still caps the worst case, unlike the
// 20MB used by the routes that actually store what they receive.
//
// NOTE: this bounds COMPRESSED bytes only. It is not a memory bound -- see the
// limitInputPixels cap in lookup/vision-identify.js, which is what stops a
// decompression bomb.
const MAX_BYTES = 6 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 4 },
  fileFilter: (req, file, cb) => {
    if (ACCEPTED.has(file.mimetype)) return cb(null, true);
    // Carry a status or the global handler falls through to 500 -- which is
    // what a rejected upload returns on the files and condition routes today.
    cb(Object.assign(new Error('Unsupported image type'), { statusCode: 415 }));
  },
});

function photoUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') err.statusCode = 413;
    if (!err.statusCode) err.statusCode = 400;
    next(err);
  });
}

function makeHandler(VisionService, config) {
  return async function identifyPhotoHandler(req, res) {
    // Rides every response from this route, success or empty, so the client
    // can gate the match feature before it ever calls POST /matches — that
    // route's own 503 arrives too late, after step 2 has already been hidden
    // in favor of "finding this product". Computed straight from config, not
    // from VisionService: MATCH_ENABLED and VISION_ENABLED are independent
    // switches (a household may run one without the other), so this must not
    // be derived from vision's own availability.
    const matchAvailable = !!(config && config.match && config.match.enabled);

    // Answered before the file is even looked at, so a fresh install with no key
    // costs one round trip and nothing else.
    if (!VisionService.isEnabled()) {
      return success(res, { available: false, suggestion: null, matchAvailable });
    }
    if (!req.file) return error(res, 'A photo is required', 422);

    // The declared type is the client's claim; the bytes are the fact, and the
    // bytes are what gets sent upstream. A mislabelled file is rejected here
    // having spent nothing.
    const sniffed = sniffMime(req.file.buffer);
    if (!sniffed || !ACCEPTED.has(sniffed)) {
      return error(res, 'That file is not an image we can read', 415);
    }

    const { error: verr } = identifyPhoto.validate(req.body || {}, { abortEarly: false });
    if (verr) return error(res, 'Validation failed', 422, verr.details.map((d) => d.message));

    // Cancel the upstream call if the browser hangs up -- the draft is gone,
    // there is nothing left to wait for.
    //
    // This listens on RES, not REQ. On Node 16+ an IncomingMessage emits
    // 'close' when the request is COMPLETE, not only when the peer
    // disconnects -- and multer has already consumed the body by the time this
    // handler runs, so req 'close' fires immediately, on the same tick.
    // Aborting there cancelled the model call the instant it was made, on every
    // single request. The user saw "nothing recognised"; the log said nothing,
    // because a cancelled call throws and the throw was logged below error.
    //
    // Verified both directions: a normal request is not aborted mid-handler,
    // and a client that hangs up early does abort the work.
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const result = await VisionService.identify(
      req.file.buffer, sniffed, req.user.id, controller.signal,
    );
    return success(res, { ...result, matchAvailable });
  };
}

module.exports = { photoUpload, makeHandler, MAX_BYTES, ACCEPTED };
