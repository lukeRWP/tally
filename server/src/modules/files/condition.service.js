const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const storage = require('../../infrastructure/storage');

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
      `SELECT cs.*, u.NAME AS RECORDED_BY_NAME
       FROM TALLY.condition_snapshots cs
       LEFT JOIN TALLY.users u ON cs.RECORDED_BY = u.ID
       WHERE cs.ITEM_ID = ?
       ORDER BY cs.CREATED_AT DESC`,
      [itemId]
    );

    return Promise.all(
      rows.map(async (row) => {
        const snapshot = ConditionService._mapSnapshot(row);
        snapshot.photoUrl = await storage.getPresignedUrl(row.PHOTO_KEY);
        return snapshot;
      })
    );
  },

  async create(itemId, data, photoFile, userId) {
    const uuid = uuidv4();
    const key = `items/${itemId}/conditions/${uuid}-${safeName(photoFile.originalname)}`;

    // Upload original photo to MinIO
    await storage.upload(key, photoFile.buffer, photoFile.mimetype);

    // Create and upload thumbnail (200px wide)
    const thumbnailKey = `items/${itemId}/conditions/${uuid}-thumb-${safeName(photoFile.originalname)}`;
    const thumbnailBuffer = await sharp(photoFile.buffer)
      .resize({ width: 200 })
      .toBuffer();
    await storage.upload(thumbnailKey, thumbnailBuffer, photoFile.mimetype);

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
      `SELECT cs.*, u.NAME AS RECORDED_BY_NAME
       FROM TALLY.condition_snapshots cs
       LEFT JOIN TALLY.users u ON cs.RECORDED_BY = u.ID
       WHERE cs.ID = ?`,
      [result.insertId]
    );

    const snapshot = ConditionService._mapSnapshot(rows[0]);
    snapshot.photoUrl = await storage.getPresignedUrl(key);
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
