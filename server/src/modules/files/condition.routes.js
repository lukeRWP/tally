const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

module.exports = function conditionRoutes({ app, db, logger }) {
  const ConditionService = require('./condition.service');
  ConditionService.init({ db, logger });

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

  // GET /api/conditions/_x_/item/:itemId — condition history (any member)
  app.get('/api/conditions/_x_/item/:itemId', requireAuth, resolvePropertyFromItem, resolvePropertyRole, async (req, res) => {
    if (!req.propertyRole) return error(res, 'Access denied', 403);
    const snapshots = await ConditionService.getByItem(req.params.itemId);
    success(res, snapshots);
  });

  // POST /api/conditions/_y_/item/:itemId — create snapshot (owner/editor)
  app.post('/api/conditions/_y_/item/:itemId', requireAuth, resolvePropertyFromItem, resolvePropertyRole, requireRole('owner', 'editor'), upload.single('photo'), async (req, res) => {
    if (!req.file) return error(res, 'Photo is required', 400);
    const data = { condition: req.body.condition, notes: req.body.notes };
    const snapshot = await ConditionService.create(req.params.itemId, data, req.file, req.user.id);
    success(res, snapshot, 'Condition recorded', 201);
  });

  // DELETE /api/conditions/_d_/:snapshotId — delete snapshot (owner only)
  app.delete('/api/conditions/_d_/:snapshotId', requireAuth, async (req, res) => {
    await ConditionService.delete(req.params.snapshotId);
    success(res, null, 'Snapshot deleted');
  });
};
