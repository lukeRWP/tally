const path = require('path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const storage = require('../../infrastructure/storage');
const { sniffMime } = require('../../utils/fileType');

function safeName(originalname) {
  return path.basename(originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
}

let _db = null;
let _logger = null;

const ConditionService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapSnapshot(row) {
    return {
      id: row.ID,
      itemId: row.ITEM_ID,
      condition: row.CONDITION,
      photoKey: row.PHOTO_KEY,
      notes: row.NOTES || null,
      recordedBy: row.RECORDED_BY,
      recordedByName: row.RECORDED_BY_NAME || null,
      createdAt: row.CREATED_AT,
    };
  },

  async getSnapshotRow(snapshotId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.condition_snapshots WHERE ID = ?',
      [snapshotId]
    );
    return rows[0] || null;
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByItem(itemId) {
    const rows = await _db.query(
      `SELECT cs.*, u.DISPLAY_NAME AS RECORDED_BY_NAME
       FROM TALLY.condition_snapshots cs
       LEFT JOIN TALLY.users u ON cs.RECORDED_BY = u.ID
       WHERE cs.ITEM_ID = ?
       ORDER BY cs.CREATED_AT DESC`,
      [itemId]
    );

    return Promise.all(
      rows.map(async (row) => {
        const snapshot = ConditionService._mapSnapshot(row);
        // Condition photos are always verified images — serve inline for display.
        snapshot.photoUrl = await storage.getPresignedUrl(row.PHOTO_KEY, { inline: true });
        return snapshot;
      })
    );
  },

  async create(itemId, data, photoFile, userId) {
    // A condition snapshot must be a real image — verify the bytes.
    const contentType = sniffMime(photoFile.buffer);
    if (!contentType || !contentType.startsWith('image/')) {
      const err = new Error('Condition photo must be a valid image (JPEG, PNG, GIF, or WebP)');
      err.statusCode = 400;
      throw err;
    }

    const uuid = randomUUID();
    const key = `items/${itemId}/conditions/${uuid}-${safeName(photoFile.originalname)}`;

    // Upload original photo to MinIO with the server-derived content type
    await storage.upload(key, photoFile.buffer, contentType);

    // Create and upload thumbnail (200px wide)
    const thumbnailKey = `items/${itemId}/conditions/${uuid}-thumb-${safeName(photoFile.originalname)}`;
    const thumbnailBuffer = await sharp(photoFile.buffer)
      .resize({ width: 200 })
      .toBuffer();
    await storage.upload(thumbnailKey, thumbnailBuffer, contentType);

    // Insert condition snapshot record
    const result = await _db.query(
      `INSERT INTO TALLY.condition_snapshots (ITEM_ID, \`CONDITION\`, PHOTO_KEY, NOTES, RECORDED_BY)
       VALUES (?, ?, ?, ?, ?)`,
      [itemId, data.condition, key, data.notes || null, userId]
    );

    // Update current condition on the item
    await _db.query(
      'UPDATE TALLY.items SET `CONDITION` = ? WHERE ID = ?',
      [data.condition, itemId]
    );

    // Fetch and return the new snapshot with presigned URL
    const rows = await _db.query(
      `SELECT cs.*, u.DISPLAY_NAME AS RECORDED_BY_NAME
       FROM TALLY.condition_snapshots cs
       LEFT JOIN TALLY.users u ON cs.RECORDED_BY = u.ID
       WHERE cs.ID = ?`,
      [result.insertId]
    );

    const snapshot = ConditionService._mapSnapshot(rows[0]);
    snapshot.photoUrl = await storage.getPresignedUrl(key, { contentType, fileName: photoFile.originalname });
    return snapshot;
  },

  async delete(snapshotId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.condition_snapshots WHERE ID = ?',
      [snapshotId]
    );

    if (!rows.length) return null;

    const record = rows[0];
    await storage.remove(record.PHOTO_KEY);
    await _db.query('DELETE FROM TALLY.condition_snapshots WHERE ID = ?', [snapshotId]);
  },
};

module.exports = ConditionService;
