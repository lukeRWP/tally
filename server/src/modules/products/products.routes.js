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

      // Online results never touch _mapProduct — they are raw adapter shapes,
      // so the short name has to be attached here or adoptProduct gets the
      // full marketing title back.
      success(res, { products, onlineProducts: onlineProducts.map(ProductsService.withShortName) });
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

  // ── Extract product from URL ────────────────────────────────────────────────

  // POST /api/products/_y_/extract-url
  app.post(
    '/api/products/_y_/extract-url',
    app.locals.requireAuth,
    async (req, res) => {
      const { url } = req.body;
      if (!url || typeof url !== 'string') {
        return error(res, 'URL is required', 422);
      }
      try {
        new URL(url); // validate URL format
      } catch {
        return error(res, 'Invalid URL', 422);
      }
      try {
        const urlExtractor = require('./lookup/url-extractor');
        const product = await urlExtractor.extractFromUrl(url);
        if (!product) return error(res, 'Could not extract product details from URL', 404);
        success(res, { product: ProductsService.withShortName(product) });
      } catch (err) {
        logger.warn('URL extraction failed', { url, error: err.message });
        return error(res, `Failed to fetch URL: ${err.message}`, 500);
      }
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
