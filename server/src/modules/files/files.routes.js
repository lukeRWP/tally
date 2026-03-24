const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

module.exports = function filesRoutes({ app, db, logger, config }) {
  const FilesService = require('./files.service');
  FilesService.init({ db, logger });

  const { success, error } = require('../../utils/response');
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
  app.post('/api/files/_y_/item/:itemId/upload', requireAuth, resolvePropertyFromItem, resolvePropertyRole, requireRole('owner', 'editor'), upload.single('file'), async (req, res) => {
    if (!req.file) return error(res, 'No file provided', 400);
    const fileType = req.body.fileType || 'other';
    const result = await FilesService.upload(req.params.itemId, req.file, fileType, req.user.id);
    success(res, result, 'File uploaded', 201);
  });

  // GET /api/files/_x_/:fileId/url — presigned download URL
  app.get('/api/files/_x_/:fileId/url', requireAuth, async (req, res) => {
    const url = await FilesService.getPresignedUrl(req.params.fileId);
    success(res, { url });
  });

  // DELETE /api/files/_d_/:fileId — delete file
  app.delete('/api/files/_d_/:fileId', requireAuth, async (req, res) => {
    await FilesService.delete(req.params.fileId, req.user.id);
    success(res, null, 'File deleted');
  });
};
