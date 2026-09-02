const { memoryUpload, single } = require('../../utils/upload');

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  // SVG removed — can contain <script> tags (stored XSS)
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const upload = memoryUpload({ accepted: ALLOWED_MIMES, maxBytes: 20 * 1024 * 1024, message: 'File type not allowed' });

module.exports = function filesRoutes({ app, db, logger, config }) {
  const FilesService = require('./files.service');
  // Background list-row thumbnails. Owns no routes — it is initialised here
  // because this module owns files, and items.service calls into it on read.
  require('./thumbnails.service').init({ db, logger });
  FilesService.init({ db, logger });

  const { success, error } = require('../../utils/response');
  const { uploadFile } = require('./files.schema');
  const { requireAuth, resolvePropertyRole, requireRole } = app.locals;
  const ItemsService = require('../inventory/items.service');

  async function resolvePropertyFromItem(req, res, next) {
    const itemId = req.params.itemId;
    const propertyId = await ItemsService.getPropertyIdForItem(itemId);
    if (!propertyId) return error(res, 'Item not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // GET /api/files/_x_/item/:itemId — list files (any member)
  app.get('/api/files/_x_/item/:itemId', requireAuth, resolvePropertyFromItem, resolvePropertyRole, async (req, res) => {
    if (!req.propertyRole) return error(res, 'Access denied', 403);
    const files = await FilesService.getByItem(req.params.itemId);
    success(res, files);
  });

  // POST /api/files/_y_/item/:itemId/upload — upload file (owner/editor)
  app.post('/api/files/_y_/item/:itemId/upload', requireAuth, resolvePropertyFromItem, resolvePropertyRole, requireRole('owner', 'editor'), single(upload, 'file'), async (req, res) => {
    if (!req.file) return error(res, 'No file provided', 400);
    // Validate fileType against the known set before it's interpolated into the
    // storage object key — an arbitrary/unsanitized value would otherwise let a
    // caller shape the key namespace. (Wires up the previously-dead uploadFile
    // schema.)
    const { error: verr, value } = uploadFile.validate({ fileType: req.body.fileType || 'other' });
    if (verr) return error(res, 'Validation failed', 422, verr.details.map(d => d.message));
    const result = await FilesService.upload(req.params.itemId, req.file, value.fileType, req.user.id);
    success(res, result, 'File uploaded', 201);
  });

  async function resolvePropertyFromFile(req, res, next) {
    const fileId = req.params.fileId;
    const rows = await FilesService.getFileRow(fileId);
    if (!rows) return error(res, 'File not found', 404);
    const propertyId = await ItemsService.getPropertyIdForItem(rows.ITEM_ID);
    if (!propertyId) return error(res, 'File not found', 404);
    req.params.propertyId = propertyId;
    next();
  }

  // GET /api/files/_x_/:fileId/url — presigned download URL (any member)
  app.get('/api/files/_x_/:fileId/url', requireAuth, resolvePropertyFromFile, resolvePropertyRole, async (req, res) => {
    if (!req.propertyRole) return error(res, 'Access denied', 403);
    const url = await FilesService.getPresignedUrl(req.params.fileId);
    success(res, { url });
  });

  // DELETE /api/files/_d_/:fileId — delete file (owner/editor)
  app.delete('/api/files/_d_/:fileId', requireAuth, resolvePropertyFromFile, resolvePropertyRole, requireRole('owner', 'editor'), async (req, res) => {
    await FilesService.delete(req.params.fileId, req.user.id);
    success(res, null, 'File deleted');
  });
};
