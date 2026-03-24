const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const storage = require('../../infrastructure/storage');

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

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByItem(itemId) {
    const rows = await _db.query(
      'SELECT * FROM TALLY.item_files WHERE ITEM_ID = ? ORDER BY CREATED_AT DESC',
      [itemId]
    );

    return Promise.all(
      rows.map(async (row) => {
        const file = FilesService._mapFile(row);
        file.url = await storage.getPresignedUrl(row.FILE_KEY);
        return file;
      })
    );
  },

  async upload(itemId, file, fileType, userId) {
    const uuid = uuidv4();
    const key = `items/${itemId}/${fileType}/${uuid}-${file.originalname}`;

    // Upload original file
    await storage.upload(key, file.buffer, file.mimetype);

    // If image, also create and upload thumbnail
    if (file.mimetype.startsWith('image/')) {
      const thumbnailKey = `items/${itemId}/${fileType}/${uuid}-thumb-${file.originalname}`;
      const thumbnailBuffer = await sharp(file.buffer)
        .resize({ width: 200 })
        .toBuffer();
      await storage.upload(thumbnailKey, thumbnailBuffer, file.mimetype);
    }

    // Insert record into DB
    const result = await _db.query(
      `INSERT INTO TALLY.item_files (ITEM_ID, FILE_TYPE, FILE_KEY, FILE_NAME, MIME_TYPE, FILE_SIZE, UPLOADED_BY)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [itemId, fileType, key, file.originalname, file.mimetype, file.size, userId]
    );

    const rows = await _db.query(
      'SELECT * FROM TALLY.item_files WHERE ID = ?',
      [result.insertId]
    );

    const fileRecord = FilesService._mapFile(rows[0]);
    fileRecord.url = await storage.getPresignedUrl(key);
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

    return storage.getPresignedUrl(rows[0].FILE_KEY);
  },
};

module.exports = FilesService;
