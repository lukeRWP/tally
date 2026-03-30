module.exports = function productsRoutes({ app, db, logger }) {
  const ProductsService = require('./products.service');
  ProductsService.init({ db, logger });

  const { createProduct, updateProduct, lookupBarcode } = require('./products.schema');
  const { success, error } = require('../../utils/response');

  // ── Get by Barcode (local only) ───────────────────────────────────────────
  // NOTE: Must be registered before /:productId to avoid "barcode" matching as a param

  // GET /api/products/_x_/barcode/:barcode
  app.get(
    '/api/products/_x_/barcode/:barcode',
    app.locals.requireAuth,
    async (req, res) => {
      const product = await ProductsService.getByBarcode(req.params.barcode);
      if (!product) return error(res, 'Product not found', 404);
      success(res, { product });
    }
  );

  // ── Text Search ────────────────────────────────────────────────────────────
  // NOTE: Must be registered before /:productId to avoid "search" matching as a param

  // GET /api/products/_x_/search?q=...&online=true
  app.get(
    '/api/products/_x_/search',
    app.locals.requireAuth,
    async (req, res) => {
      const q = req.query.q;
      if (!q || !q.trim()) return error(res, 'Search query is required', 422);

      // Search local catalog first
      const products = await ProductsService.searchByText(q);

      // If local is empty and online flag is set, search external APIs
      const includeOnline = req.query.online === 'true';
      let onlineProducts = [];
      if (includeOnline) {
        const textSearch = require('./lookup/text-search');
        try {
          onlineProducts = await textSearch.searchByText(q);
        } catch (err) {
          logger.warn('Online product search failed', { query: q, error: err.message });
        }
      }

      success(res, { products, onlineProducts });
    }
  );

  // ── Get by ID ──────────────────────────────────────────────────────────────

  // GET /api/products/_x_/:productId
  app.get(
    '/api/products/_x_/:productId',
    app.locals.requireAuth,
    async (req, res) => {
      const product = await ProductsService.getById(req.params.productId);
      if (!product) return error(res, 'Product not found', 404);
      success(res, { product });
    }
  );

  // ── Lookup Barcode (local → external) ──────────────────────────────────────

  // POST /api/products/_y_/lookup
  app.post(
    '/api/products/_y_/lookup',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = lookupBarcode.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const result = await ProductsService.lookupBarcode(value.barcode);
      success(res, result);
    }
  );

  // ── Create Product ─────────────────────────────────────────────────────────

  // POST /api/products/_y_/create
  app.post(
    '/api/products/_y_/create',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = createProduct.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const product = await ProductsService.create(value);
      success(res, { product }, 'Product created', 201);
    }
  );

  // ── Update Product ─────────────────────────────────────────────────────────

  // PUT /api/products/_u_/:productId
  app.put(
    '/api/products/_u_/:productId',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = updateProduct.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const product = await ProductsService.update(req.params.productId, value);
      if (!product) return error(res, 'Product not found', 404);
      success(res, { product });
    }
  );

  // ── Check Duplicate ────────────────────────────────────────────────────────

  // POST /api/products/_y_/check-duplicate
  app.post(
    '/api/products/_y_/check-duplicate',
    app.locals.requireAuth,
    async (req, res) => {
      const { error: validationError, value } = lookupBarcode.validate(req.body, { abortEarly: false });
      if (validationError) {
        return error(res, 'Validation failed', 422, validationError.details.map(d => d.message));
      }
      const existingItems = await ProductsService.checkDuplicate(value.barcode, req.user.id);
      success(res, { existingItems });
    }
  );
};
