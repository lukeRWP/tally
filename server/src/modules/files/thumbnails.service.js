const sharp = require('sharp');
const storage = require('../../infrastructure/storage');

/**
 * List-row thumbnails, generated in the background.
 *
 * An upload is downscaled to 1600px and then rendered into a 32x32 box, so a
 * list pulls megabytes to draw postage stamps. This produces a small derivative
 * once, the first time a photo is asked for, and records its key so the read
 * path never has to ask storage whether one exists.
 *
 * Everything here is fire-and-forget. A thumbnail is an optimisation; the read
 * path falls back to the original, so a failure here must never surface to a
 * user or delay a response.
 */

const THUMB_PX = 256;          // 4x the 64px CSS box, so it stays sharp on a 3x phone
const THUMB_QUALITY = 72;
const MAX_CONCURRENT = 2;      // resizing competes with request handling for CPU
const RETRY_AFTER_MS = 60 * 60 * 1000;
/**
 * Bigger than any photo the capture flow produces (it downscales to 1600px), so
 * this only ever rejects something pathological — a decompression bomb, or a
 * file that is not really an image.
 */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

let _db = null;
let _logger = null;

/** Keys currently being generated — a list of 40 rows must not queue 40 copies. */
const inFlight = new Set();
/**
 * Keys whose generation failed, and when.
 *
 * Without this a photo sharp cannot decode is retried on every single list
 * render, forever: a permanent failure becomes a permanent load.
 */
const failed = new Map();

let running = 0;
const waiting = [];

function _slot() {
  if (running < MAX_CONCURRENT) { running += 1; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}

function _release() {
  const next = waiting.shift();
  if (next) next(); else running -= 1;
}

/** Derived, not stored: the original key is already unique per upload. */
function thumbKeyFor(originalKey) {
  return `thumbs/${THUMB_PX}/${originalKey}`;
}

const ThumbnailsService = {
  init({ db, logger }) {
    _db = db;
    _logger = logger;
    inFlight.clear();
    failed.clear();
  },

  /**
   * Ensure a thumbnail exists for an original key, eventually.
   *
   * Returns immediately. Callers are read paths serving a page — they must not
   * wait on this, and must not care whether it succeeds.
   */
  ensure(originalKey) {
    if (!_db || !originalKey) return;
    if (inFlight.has(originalKey)) return;

    const lastFailure = failed.get(originalKey);
    if (lastFailure && Date.now() - lastFailure < RETRY_AFTER_MS) return;

    inFlight.add(originalKey);
    // Deliberately not awaited. The catch is the only thing keeping a rejected
    // promise from becoming an unhandled rejection that takes the process down.
    ThumbnailsService._generate(originalKey)
      .catch(() => { /* _generate logs and records; nothing to do here */ })
      .finally(() => inFlight.delete(originalKey));
  },

  async _generate(originalKey) {
    await _slot();
    const started = Date.now();
    try {
      const source = await storage.getObject(originalKey);
      if (source.length > MAX_SOURCE_BYTES) {
        throw new Error(`source too large: ${source.length} bytes`);
      }

      const thumb = await sharp(source, { limitInputPixels: 50 * 1000 * 1000 })
        .rotate()                               // honour EXIF, or phone photos come out sideways
        .resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY })
        .toBuffer();

      const key = thumbKeyFor(originalKey);
      await storage.upload(key, thumb, 'image/jpeg');

      // FILE_KEY carries a randomUUID, so it identifies exactly one row.
      await _db.query(
        'UPDATE TALLY.item_files SET THUMB_KEY = ? WHERE FILE_KEY = ?',
        [key, originalKey],
      );

      _logger?.info?.('Thumbnail generated', {
        originalKey, bytes: source.length, thumbBytes: thumb.length, ms: Date.now() - started,
      });
    } catch (err) {
      failed.set(originalKey, Date.now());
      // warn, not error: the page still rendered, with the original. This is a
      // missed optimisation, not a broken request.
      _logger?.warn?.('Thumbnail generation failed', {
        originalKey, ms: Date.now() - started, message: err?.message ?? null,
      });
      throw err;
    } finally {
      _release();
    }
  },
};

module.exports = ThumbnailsService;
module.exports.thumbKeyFor = thumbKeyFor;
module.exports.THUMB_PX = THUMB_PX;
