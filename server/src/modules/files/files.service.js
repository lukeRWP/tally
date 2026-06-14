const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const storage = require('../../infrastructure/storage');
const { sniffMime } = require('../../utils/fileType');

function safeName(originalname) {
  return path.basename(originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
}

let _db = null;
let _logger = null;

const FilesService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    _db = db;
    _logger = logger;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapFile(row) {
    return {
      id: row.ID,
      itemId: row.ITEM_ID,
      fileType: row.FILE_TYPE,
      fileKey: row.FILE_KEY,
      fileName: row.FILE_NAME,
      mimeType: row.MIME_TYPE,
      fileSize: row.FILE_SIZE,
      uploadedBy: row.UPLOADED_BY,
      createdAt: row.CREATED_AT,
    };
  },

  async getFileRow(fileId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.item_files WHERE ID = ?',
      [fileId]
    );
    return rows[0] || null;
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByItem(itemId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.item_files WHERE ITEM_ID = ? ORDER BY CREATED_AT DESC',
      [itemId]
    );

    return Promise.all(
      rows.map(async (row) => {
        const file = FilesService._mapFile(row);
        file.url = await storage.getPresignedUrl(row.FILE_KEY, { contentType: row.MIME_TYPE, fileName: row.FILE_NAME });
        return file;
      })
    );
  },

  async upload(itemId, file, fileType, userId) {
    // Verify the actual bytes match the declared type for formats we can
    // fingerprint (images, pdf) — blocks e.g. an HTML/script payload uploaded
    // as image/png. text/csv/office types have no reliable magic bytes; they
    // are always served as downloads (never inline), so they can't execute.
    const sniffed = sniffMime(file.buffer);
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      if (sniffed !== file.mimetype) {
        const err = new Error('File content does not match its declared type');
        err.statusCode = 400;
        throw err;
      }
    }
    const contentType = sniffed || file.mimetype; // server-derived, never trust the client for inline-able types

    const uuid = uuidv4();
    const key = `items/${itemId}/${fileType}/${uuid}-${safeName(file.originalname)}`;

    // Upload original file with the server-derived content type
    await storage.upload(key, file.buffer, contentType);

    // If a verified image, also create and upload a thumbnail
    if (contentType.startsWith('image/')) {
      const thumbnailKey = `items/${itemId}/${fileType}/${uuid}-thumb-${safeName(file.originalname)}`;
      const thumbnailBuffer = await sharp(file.buffer)
        .resize({ width: 200 })
        .toBuffer();
      await storage.upload(thumbnailKey, thumbnailBuffer, contentType);
    }

    // Insert record into DB (store the server-derived MIME, not the client's)
    const result = await _db.query(
      `INSERT INTO TALLY.item_files (ITEM_ID, FILE_TYPE, FILE_KEY, FILE_NAME, MIME_TYPE, FILE_SIZE, UPLOADED_BY)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [itemId, fileType, key, file.originalname, contentType, file.size, userId]
    );

    const rows = await _db.query(
      'SELECT * FROM TALLY.item_files WHERE ID = ?',
      [result.insertId]
    );

    const fileRecord = FilesService._mapFile(rows[0]);
    fileRecord.url = await storage.getPresignedUrl(key, { contentType, fileName: file.originalname });
    return fileRecord;
  },

  async delete(fileId, userId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.item_files WHERE ID = ?',
      [fileId]
    );

    if (!rows.length) return null;

    const file = rows[0];
    await storage.remove(file.FILE_KEY);
    await _db.query('DELETE FROM TALLY.item_files WHERE ID = ?', [fileId]);
  },

  async getPresignedUrl(fileId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.item_files WHERE ID = ?',
      [fileId]
    );

    if (!rows.length) return null;

    return storage.getPresignedUrl(rows[0].FILE_KEY, { contentType: rows[0].MIME_TYPE, fileName: rows[0].FILE_NAME });
  },
};

module.exports = FilesService;
