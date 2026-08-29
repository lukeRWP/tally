const { generateCode } = require('../../utils/qr');
const { simplifyProductName } = require('../../utils/product-name');
const AuditService = require('../audit/audit.service');
const RecycleService = require('../recycle/recycle.service');
const storage = require('../../infrastructure/storage');
const Thumbnails = require('../files/thumbnails.service');
const Reconcile = require('./move-reconcile.service');

let _db = null;
let _logger = null;

const ItemsService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger }) {
    RecycleService.init({ db, logger });
    _db = db;
    _logger = logger;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _mapItem(row) {
    return {
      id: row.ID,
      containerId: row.CONTAINER_ID,
      productId: row.PRODUCT_ID || null,
      name: row.NAME,
      // '' and NULL are different answers: '' means "I looked and there is
      // nothing to say", and the item page must not fall back to the product's
      // description for it.
      description: row.DESCRIPTION != null ? row.DESCRIPTION : null,
      quantity: row.QUANTITY != null ? Number(row.QUANTITY) : 1,
      qrCode: row.QR_CODE || null,
      purchasePrice: row.PURCHASE_PRICE != null ? Number(row.PURCHASE_PRICE) : null,
      // create() wrote CURRENT_VALUE and no read path ever returned it, so the
      // column was write-only from the API's side: the item page could not show
      // a value it had just saved, let alone that it was an estimate.
      currentValue: row.CURRENT_VALUE != null ? Number(row.CURRENT_VALUE) : null,
      currentValueIsEstimate: Boolean(row.CURRENT_VALUE_IS_ESTIMATE),
      condition: row.CONDITION || null,
      completeness: row.COMPLETENESS || 'complete',
      status: row.STATUS || null,
      depreciationEnabled: row.DEPRECIATION_ENABLED != null ? Boolean(row.DEPRECIATION_ENABLED) : false,
      depreciationRate: row.DEPRECIATION_RATE != null ? Number(row.DEPRECIATION_RATE) : null,
      createdAt: row.CREATED_AT,
      updatedAt: row.UPDATED_AT,
      deletedAt: row.DELETED_AT || null,
      // Product fields (from LEFT JOIN)
      productName: row.PRODUCT_NAME !== undefined ? (row.PRODUCT_NAME || null) : undefined,
      productBrand: row.PRODUCT_BRAND !== undefined ? (row.PRODUCT_BRAND || null) : undefined,
      productImageUrl: row.PRODUCT_IMAGE_URL !== undefined ? (row.PRODUCT_IMAGE_URL || null) : undefined,
      // Newest uploaded photo (the capture flow's step 1). Presigned by the
      // caller — _mapItem is sync and presigning is not.
      photoKey: row.PHOTO_KEY !== undefined ? (row.PHOTO_KEY || null) : undefined,
      photoThumbKey: row.PHOTO_THUMB_KEY !== undefined ? (row.PHOTO_THUMB_KEY || null) : undefined,
    };
  },

  /** The names of the places an item sits in, for rows that must answer "where?". */
  _locationOf(row) {
    return {
      property: row.PROPERTY_NAME || null,
      area: row.AREA_NAME || null,
      container: row.CONTAINER_NAME || null,
    };
  },

  /**
   * Lock the container row a write is about to trust, and verify it is live.
   *
   * Closes the check-then-write TOCTOU (#88): the routes validate the target
   * container via ContainersService.getActiveAreaId, but that read is
   * unlocked and runs outside any transaction, so a container soft-deleted
   * between that check and our INSERT/UPDATE would leave an active item under
   * a deleted parent — "phantom" inventory, invisible in navigation yet still
   * counted in reports/search. Re-checking with SELECT ... FOR UPDATE inside
   * the SAME transaction as the write closes the window: every soft-delete
   * that could orphan the item stamps the container row itself (the container
   * cascade and the area cascade both UPDATE TALLY.containers), so an X lock
   * on that one row serializes this write against them — whichever commits
   * first, the other sees it.
   *
   * FOR UPDATE OF c keeps the lock scope minimal: one point lock on the
   * container's PK, never a range, and the joined area row stays unlocked
   * (the container row is the synchronization point — see above). The join
   * and DELETED_AT predicates mirror getActiveAreaId exactly.
   */
  async _lockLiveContainer(tx, containerId, { statusCode = 404, message = 'Container not found' } = {}) {
    const rows = await tx.query(
      `SELECT c.ID FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       WHERE c.ID = ? AND c.DELETED_AT IS NULL AND a.DELETED_AT IS NULL
       FOR UPDATE OF c`,
      [containerId]
    );
    if (!rows.length) {
      const err = new Error(message);
      err.statusCode = statusCode;
      throw err;
    }
  },

  // ── Queries ────────────────────────────────────────────────────────────────

  async getByContainer(containerId) {
    const rows = await _db.query(
      `SELECT
         i.*,
         p.NAME AS PRODUCT_NAME,
         p.BRAND AS PRODUCT_BRAND,
         p.IMAGE_URL AS PRODUCT_IMAGE_URL,
         (SELECT f.FILE_KEY FROM TALLY.item_files f
           WHERE f.ITEM_ID = i.ID AND f.FILE_TYPE = 'photo'
           ORDER BY f.ID DESC LIMIT 1) AS PHOTO_KEY,
         -- Same ORDER BY and LIMIT, so it resolves to the same row as the key
         -- above. ID is unique, so the pairing is deterministic.
         (SELECT f.THUMB_KEY FROM TALLY.item_files f
           WHERE f.ITEM_ID = i.ID AND f.FILE_TYPE = 'photo'
           ORDER BY f.ID DESC LIMIT 1) AS PHOTO_THUMB_KEY,
         NULL AS _PHOTO_SENTINEL
       FROM TALLY.items i
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE i.CONTAINER_ID = ? AND i.DELETED_AT IS NULL`,
      [containerId]
    );
    return ItemsService._withPhotoUrls(rows.map(ItemsService._mapItem));
  },

  /**
   * Turn photoKey into a usable photoUrl. Presigned links are what the client
   * can actually render (the bucket is not public), and this is the only thing
   * that makes a captured photo visible anywhere other than the file list.
   */
  async _withPhotoUrls(items) {
    return Promise.all(items.map(async (item) => {
      if (!item.photoKey) return item;
      try {
        const [photoUrl, photoThumbUrl] = await Promise.all([
          storage.getPresignedUrl(item.photoKey, { inline: true }),
          item.photoThumbKey
            ? storage.getPresignedUrl(item.photoThumbKey, { inline: true })
            : null,
        ]);
        // No thumbnail yet — serve the original this time and make one for
        // next time. Fire-and-forget: a list render must not wait on a resize,
        // and every photo uploaded before 007 arrives here exactly once.
        if (!item.photoThumbKey) Thumbnails.ensure(item.photoKey);
        return photoThumbUrl ? { ...item, photoUrl, photoThumbUrl } : { ...item, photoUrl };
      } catch {
        return item; // a missing object must not break the whole list
      }
    }));
  },

  async getById(id) {
    const rows = await _db.query(
      `SELECT
         i.*,
         p.NAME AS PRODUCT_NAME,
         p.BRAND AS PRODUCT_BRAND,
         p.IMAGE_URL AS PRODUCT_IMAGE_URL,
         p.DESCRIPTION AS PRODUCT_DESCRIPTION,
         p.CATEGORY AS PRODUCT_CATEGORY,
         p.BARCODE AS PRODUCT_BARCODE,
         p.RETAIL_PRICE AS PRODUCT_RETAIL_PRICE,
         p.RETAIL_LINKS AS PRODUCT_RETAIL_LINKS,
         p.SPECS AS PRODUCT_SPECS,
         p.DATA_SOURCE AS PRODUCT_DATA_SOURCE,
         (SELECT f.FILE_KEY FROM TALLY.item_files f
           WHERE f.ITEM_ID = i.ID AND f.FILE_TYPE = 'photo'
           ORDER BY f.ID DESC LIMIT 1) AS PHOTO_KEY,
         -- Same ORDER BY and LIMIT, so it resolves to the same row as the key
         -- above. ID is unique, so the pairing is deterministic.
         (SELECT f.THUMB_KEY FROM TALLY.item_files f
           WHERE f.ITEM_ID = i.ID AND f.FILE_TYPE = 'photo'
           ORDER BY f.ID DESC LIMIT 1) AS PHOTO_THUMB_KEY,
         c.NAME AS CONTAINER_NAME,
         a.ID AS AREA_ID,
         a.NAME AS AREA_NAME,
         a.PROPERTY_ID AS PROPERTY_ID,
         pr.NAME AS PROPERTY_NAME
       FROM TALLY.items i
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID
       WHERE i.ID = ?`,
      [id]
    );
    if (!rows.length) return null;

    const row = rows[0];
    const item = ItemsService._mapItem(row);

    // Enrich with full product data
    if (row.PRODUCT_DESCRIPTION !== undefined) {
      item.productDescription = row.PRODUCT_DESCRIPTION || null;
    }
    if (row.PRODUCT_CATEGORY !== undefined) {
      item.productCategory = row.PRODUCT_CATEGORY || null;
    }
    if (row.PRODUCT_BARCODE !== undefined) {
      item.productBarcode = row.PRODUCT_BARCODE || null;
    }
    if (row.PRODUCT_RETAIL_PRICE !== undefined) {
      item.productRetailPrice = row.PRODUCT_RETAIL_PRICE != null ? parseFloat(row.PRODUCT_RETAIL_PRICE) : null;
    }
    if (row.PRODUCT_RETAIL_LINKS !== undefined) {
      let links = row.PRODUCT_RETAIL_LINKS;
      if (typeof links === 'string') { try { links = JSON.parse(links); } catch { links = null; } }
      item.productRetailLinks = links || null;
    }
    if (row.PRODUCT_SPECS !== undefined) {
      let specs = row.PRODUCT_SPECS;
      if (typeof specs === 'string') { try { specs = JSON.parse(specs); } catch { specs = null; } }
      item.productSpecs = specs || null;
    }
    if (row.PRODUCT_DATA_SOURCE !== undefined) {
      item.productDataSource = row.PRODUCT_DATA_SOURCE || null;
    }

    // Anything filed before the shortener existed still wears its catalogue
    // title verbatim, and only those rows are offered a shorter one. Keying on
    // an exact match rather than "differs from the product" matters: a name
    // someone chose themselves would otherwise be nagged back towards the
    // marketing copy they were replacing.
    //
    // Safe where a bulk rewrite is not — the original survives on the product,
    // the change is one deliberate tap by someone looking at both, and it lands
    // in History like any other edit. Null once taken, since shortening twice
    // is a no-op.
    const catalogueTitle = row.PRODUCT_NAME || null;
    const suggested = catalogueTitle && catalogueTitle === item.name
      ? simplifyProductName(catalogueTitle)
      : null;
    item.suggestedName = suggested && suggested !== item.name ? suggested : null;

    // Build breadcrumb: property → area → container
    item.breadcrumb = [
      { id: row.PROPERTY_ID, name: row.PROPERTY_NAME || null, type: 'property' },
      { id: row.AREA_ID, name: row.AREA_NAME || null, type: 'area' },
      { id: row.CONTAINER_ID, name: row.CONTAINER_NAME || null, type: 'container' },
    ];

    // Presign the photo the same way the container listing does — the detail
    // page is where the picture you took most deserves to be shown, and it was
    // the one query that never carried it.
    const [withPhoto] = await ItemsService._withPhotoUrls([item]);
    return withPhoto;
  },

  async create(data, userId) {
    // ONE statement, two call sites.
    //
    // The QR-collision retry used to carry its own copy of this INSERT, and the
    // two had drifted: the retry's column list omitted CURRENT_VALUE, so an
    // item created on a colliding code silently lost its value. Nothing failed
    // and nothing logged — the item just appeared worth nothing.
    //
    // Duplicating a column list is how that happens, so there is now only one
    // to keep in step. Adding CURRENT_VALUE_IS_ESTIMATE to a divergent pair
    // would have reproduced the same bug with the provenance flag.
    const insert = (tx, qrCode) => tx.query(
      `INSERT INTO TALLY.items
         (CONTAINER_ID, PRODUCT_ID, NAME, DESCRIPTION, QUANTITY, QR_CODE, PURCHASE_PRICE, CURRENT_VALUE, CURRENT_VALUE_IS_ESTIMATE, \`CONDITION\`, COMPLETENESS, STATUS)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        data.containerId,
        data.productId || null,
        data.name,
        data.description || null,
        data.quantity != null ? data.quantity : 1,
        qrCode,
        data.purchasePrice != null ? data.purchasePrice : null,
        data.currentValue != null ? data.currentValue : null,
        // Only meaningful alongside a value. A flag with no number would claim
        // provenance for something that does not exist.
        data.currentValue != null && data.currentValueIsEstimate ? 1 : 0,
        data.condition || 'good',
        data.completeness || 'complete',
      ]
    );

    let result;
    await _db.withTransaction(async (tx) => {
      // The route's liveness check on the target container is unlocked and
      // pre-transactional; this locked re-check, in the same transaction as
      // the INSERT, is the one that holds (#88) — see _lockLiveContainer.
      await ItemsService._lockLiveContainer(tx, data.containerId);
      try {
        result = await insert(tx, generateCode('item'));
      } catch (err) {
        // Duplicate QR code — retry once with a new code. ER_DUP_ENTRY aborts
        // only the statement, not the transaction, so the retry (and the
        // container lock above) stay live inside it.
        if (err.code === 'ER_DUP_ENTRY' && err.message.includes('qr_code')) {
          result = await insert(tx, generateCode('item'));
        } else {
          throw err;
        }
      }
    });

    const propertyId = await ItemsService.getPropertyIdForItem(result.insertId);
    AuditService.logChange(userId, 'item', result.insertId, 'created', data, propertyId);
    return ItemsService.getById(result.insertId);
  },

  async update(id, data, userId) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('NAME = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('DESCRIPTION = ?'); values.push(data.description); }
    if (data.quantity !== undefined) { fields.push('QUANTITY = ?'); values.push(data.quantity); }
    if (data.purchasePrice !== undefined) { fields.push('PURCHASE_PRICE = ?'); values.push(data.purchasePrice); }
    // Editing the value ALWAYS clears the estimate flag, and the flag is not
    // settable here on purpose. A number arriving through this route was typed
    // by a person, which is the definition of declared — so provenance is
    // derived from which path wrote it rather than asserted by the caller, and
    // no client can mark its own guess as declared or vice versa.
    if (data.currentValue !== undefined) {
      fields.push('CURRENT_VALUE = ?');
      values.push(data.currentValue);
      fields.push('CURRENT_VALUE_IS_ESTIMATE = 0');
    }
    if (data.condition !== undefined) { fields.push('`CONDITION` = ?'); values.push(data.condition); }
    if (data.completeness !== undefined) { fields.push('COMPLETENESS = ?'); values.push(data.completeness); }
    if (data.depreciationEnabled !== undefined) { fields.push('DEPRECIATION_ENABLED = ?'); values.push(data.depreciationEnabled ? 1 : 0); }
    if (data.depreciationRate !== undefined) { fields.push('DEPRECIATION_RATE = ?'); values.push(data.depreciationRate); }

    if (!fields.length) return ItemsService.getById(id);

    values.push(id);
    await _db.query(
      `UPDATE TALLY.items SET ${fields.join(', ')} WHERE ID = ?`,
      values
    );

    const propertyId = await ItemsService.getPropertyIdForItem(id);
    AuditService.logChange(userId, 'item', id, 'updated', data, propertyId);

    return ItemsService.getById(id);
  },

  async move(id, newContainerId, userId, opts = {}) {
    const cross = opts.crossProperty;
    if (!cross) {
      // Same statement, same single 'moved' audit — but the check and the
      // write now share one transaction (#88): the route's liveness check on
      // the destination is unlocked, so without the locked re-check here a
      // container recycled in between would swallow the item — see
      // _lockLiveContainer.
      await _db.withTransaction(async (tx) => {
        await ItemsService._lockLiveContainer(tx, newContainerId, { message: 'Destination container not found' });
        await tx.query(
          'UPDATE TALLY.items SET CONTAINER_ID = ? WHERE ID = ?',
          [newContainerId, id]
        );
      });
      const propertyId = await ItemsService.getPropertyIdForItem(id);
      AuditService.logChange(userId, 'item', id, 'moved', { containerId: newContainerId }, propertyId);
      return { item: await ItemsService.getById(id), consequences: null };
    }

    // Cross-property: the move and its reconciliation commit or roll back
    // together — a moved item with stranded tag rows would be worse than a
    // refused move.
    let consequences = null;
    const moveArgs = {
      srcPropertyId: cross.srcPropertyId,
      destPropertyId: cross.destPropertyId,
      userId,
      rootType: 'item',
      rootId: Number(id),
      moveChanges: { containerId: newContainerId },
    };
    await _db.withTransaction(async (tx) => {
      // Authoritative destination-liveness check (#88) — the route's was
      // unlocked and pre-transactional. See _lockLiveContainer.
      await ItemsService._lockLiveContainer(tx, newContainerId, { message: 'Destination container not found' });
      await tx.query(
        'UPDATE TALLY.items SET CONTAINER_ID = ? WHERE ID = ?',
        [newContainerId, id]
      );
      const set = await Reconcile.movingSet(tx, 'item', id);
      consequences = await Reconcile.reconcile(tx, set, moveArgs);
    });
    // Audited AFTER the transaction resolves, same as the same-property path
    // above — logChange writes through a plain pool connection, not tx, so
    // writing it any earlier would let audit rows outlive a rollback.
    Reconcile.auditMove(moveArgs);
    return { item: await ItemsService.getById(id), consequences };
  },

  async softDelete(id, userId) {
    const propertyId = await ItemsService.getPropertyIdForItem(id);
    // Block deleting an item that is currently lent out — otherwise the open
    // loan record is orphaned and then destroyed when the item is purged after
    // 30 days. The lock + open-loan check + delete run in ONE transaction so a
    // concurrent lend() (which also locks the item row FOR UPDATE) can't slip
    // an open loan in between our check and our delete — the two serialize:
    // whichever commits first, the other sees it (409 here, or 404 in lend).
    await _db.withTransaction(async (tx) => {
      await tx.query('SELECT ID FROM TALLY.items WHERE ID = ? FOR UPDATE', [id]);
      const openLoan = await tx.query(
        'SELECT 1 FROM TALLY.item_lending WHERE ITEM_ID = ? AND RETURNED_AT IS NULL LIMIT 1',
        [id]
      );
      if (openLoan.length) {
        const err = new Error('Return this item before deleting it');
        err.statusCode = 409;
        throw err;
      }
      // A single-item delete is a batch of one, so the bin can show and
      // restore it through exactly the same path as a cascade.
      const nameRows = await tx.query('SELECT NAME FROM TALLY.items WHERE ID = ?', [id]);
      const batchId = await RecycleService.openBatch(tx, {
        propertyId, rootType: 'item', rootId: id,
        rootName: nameRows[0]?.NAME || 'Item', userId,
      });
      await tx.query(
        "UPDATE TALLY.items SET DELETED_AT = NOW(), STATUS = 'removed', DELETE_BATCH_ID = ? WHERE ID = ?",
        [batchId, id]
      );
    });
    AuditService.logChange(userId, 'item', id, 'deleted', {}, propertyId);
  },

  async restore(id, userId) {
    await _db.withTransaction(async (tx) => {
      const rows = await tx.query('SELECT DELETE_BATCH_ID, CONTAINER_ID FROM TALLY.items WHERE ID = ?', [id]);
      const batchId = rows[0]?.DELETE_BATCH_ID || null;
      const containerId = rows[0]?.CONTAINER_ID;
      // The route already refused restoring into a recycled container, but
      // with an unlocked pre-transactional read; this locked re-check in the
      // restoring transaction is the one that holds (#88) — a container
      // recycled between the route's check and this UPDATE would otherwise
      // turn the restored item into phantom inventory. See _lockLiveContainer.
      if (containerId != null) {
        await ItemsService._lockLiveContainer(tx, containerId, {
          statusCode: 409,
          message: 'Restore the container this item was in before restoring the item',
        });
      }
      await tx.query(
        "UPDATE TALLY.items SET DELETED_AT = NULL, STATUS = 'active', DELETE_BATCH_ID = NULL WHERE ID = ?",
        [id]
      );
      // Drop the header once nothing is left pointing at it, or the bin would
      // keep listing a deletion whose contents are all back.
      if (batchId) {
        await tx.query(
          `DELETE FROM TALLY.delete_batches WHERE ID = ?
             AND NOT EXISTS (SELECT 1 FROM TALLY.items      x WHERE x.DELETE_BATCH_ID = ?)
             AND NOT EXISTS (SELECT 1 FROM TALLY.containers x WHERE x.DELETE_BATCH_ID = ?)
             AND NOT EXISTS (SELECT 1 FROM TALLY.areas      x WHERE x.DELETE_BATCH_ID = ?)`,
          [batchId, batchId, batchId, batchId]
        );
      }
    });
    const propertyId = await ItemsService.getPropertyIdForItem(id);
    AuditService.logChange(userId, 'item', id, 'restored', {}, propertyId);
    return ItemsService.getById(id);
  },

  async search(query, userId, { tagIds, condition, status } = {}) {
    // Strip FULLTEXT boolean operators and append * for prefix matching
    const booleanQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(word => word.replace(/[+\-><()~*"@]/g, ''))
      .filter(Boolean)
      .map(word => `${word}*`)
      .join(' ');

    const hasTagFilter = Array.isArray(tagIds) && tagIds.length > 0;

    const joins = [
      `LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID`,
      `JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID`,
      `JOIN TALLY.areas a ON c.AREA_ID = a.ID`,
      // Location names ride along so a search result can say WHERE the thing
      // is — the answer "Where is X?" actually needs. Same pattern getById uses.
      `JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID`,
      `JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID`,
    ];

    if (hasTagFilter) {
      joins.push(`JOIN TALLY.entity_tags et ON et.ENTITY_ID = i.ID AND et.ENTITY_TYPE = 'item'`);
      joins.push(`LEFT JOIN TALLY.tags t ON t.ID = et.TAG_ID`);
    }

    const where = [
      `pm.USER_ID = ?`,
      `i.DELETED_AT IS NULL`,
      `(MATCH(i.NAME, i.DESCRIPTION) AGAINST(? IN BOOLEAN MODE)
              OR (p.ID IS NOT NULL AND MATCH(p.NAME, p.BRAND, p.DESCRIPTION) AGAINST(? IN BOOLEAN MODE))
              ${hasTagFilter ? `OR t.NAME LIKE ?` : ''})`,
    ];

    const params = [userId, booleanQuery, booleanQuery];

    if (hasTagFilter) {
      // Add LIKE param for tag name search (must come right after the booleanQuery params)
      params.push(`%${query.trim()}%`);
      where.push(`et.TAG_ID IN (?)`);
      params.push(tagIds);
      // ALL-of, not any-of: a filter chip set narrows results, it doesn't
      // widen them (CLAUDE.md's tags section is explicit: "filter results to
      // items that have all specified tags"). The join above stays scoped to
      // the tag-name-search feature (`t.NAME LIKE ?`) and still explodes one
      // row per tag, so it can't itself prove an item carries every requested
      // tag — a self-contained correlated subquery does, the same derived-
      // table-with-its-own-GROUP-BY shape reports.service.js uses for
      // "latest condition snapshot", rather than a GROUP BY on this query's
      // own SELECT (which pulls in columns from four other joined tables that
      // aren't all provably functionally dependent on items.ID under
      // ONLY_FULL_GROUP_BY).
      where.push(`
        i.ID IN (
          SELECT et2.ENTITY_ID FROM TALLY.entity_tags et2
          WHERE et2.ENTITY_TYPE = 'item' AND et2.TAG_ID IN (?)
          GROUP BY et2.ENTITY_ID
          HAVING COUNT(DISTINCT et2.TAG_ID) = ?
        )`);
      params.push(tagIds, tagIds.length);
    }

    if (condition) {
      where.push(`i.\`CONDITION\` = ?`);
      params.push(condition);
    }

    if (status) {
      where.push(`i.STATUS = ?`);
      params.push(status);
    }

    const sql = `
      SELECT DISTINCT i.*, p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND,
             c.NAME AS CONTAINER_NAME, a.NAME AS AREA_NAME, pr.NAME AS PROPERTY_NAME
      FROM TALLY.items i
      ${joins.join('\n      ')}
      WHERE ${where.join('\n        AND ')}
      LIMIT 50`;

    const rows = await _db.query(sql, params);

    return rows.map(row => {
      const item = ItemsService._mapItem(row);
      // Presentation stays client-side; the server just names the places.
      item.location = ItemsService._locationOf(row);
      return item;
    });
  },

  /**
   * The newest things in the house, across every property the caller can see.
   *
   * Ordered by CREATED_AT with ID as the tiebreaker: CREATED_AT is a DATETIME
   * with one-second resolution and a capture session lands several items inside
   * the same second — without the tiebreaker their order is the optimiser's
   * choice and the list reshuffles between loads.
   */
  async getRecent(userId, { limit = 25 } = {}) {
    const rows = await _db.query(
      `SELECT
         i.*,
         p.NAME AS PRODUCT_NAME,
         p.BRAND AS PRODUCT_BRAND,
         p.IMAGE_URL AS PRODUCT_IMAGE_URL,
         (SELECT f.FILE_KEY FROM TALLY.item_files f
           WHERE f.ITEM_ID = i.ID AND f.FILE_TYPE = 'photo'
           ORDER BY f.ID DESC LIMIT 1) AS PHOTO_KEY,
         -- Same ORDER BY and LIMIT, so it resolves to the same row as the key
         -- above. ID is unique, so the pairing is deterministic.
         (SELECT f.THUMB_KEY FROM TALLY.item_files f
           WHERE f.ITEM_ID = i.ID AND f.FILE_TYPE = 'photo'
           ORDER BY f.ID DESC LIMIT 1) AS PHOTO_THUMB_KEY,
         c.NAME  AS CONTAINER_NAME,
         a.NAME  AS AREA_NAME,
         pr.NAME AS PROPERTY_NAME
       FROM TALLY.items i
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID
       JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID
       WHERE pm.USER_ID = ?
         AND i.DELETED_AT IS NULL
         AND c.DELETED_AT IS NULL
         AND a.DELETED_AT IS NULL
         AND pr.DELETED_AT IS NULL
       ORDER BY i.CREATED_AT DESC, i.ID DESC
       LIMIT ?`,
      [userId, limit]
    );

    return ItemsService._withPhotoUrls(rows.map((row) => {
      const item = ItemsService._mapItem(row);
      item.location = ItemsService._locationOf(row);
      return item;
    }));
  },

  async getPropertyIdForItem(itemId) {
    const rows = await _db.query(
      `SELECT a.PROPERTY_ID
       FROM TALLY.areas a
       JOIN TALLY.containers c ON c.AREA_ID = a.ID
       JOIN TALLY.items i ON i.CONTAINER_ID = c.ID
       WHERE i.ID = ?`,
      [itemId]
    );
    return rows[0]?.PROPERTY_ID || null;
  },

  // ── Recycle Bin ────────────────────────────────────────────────────────────

  async getDeleted(userId, { limit = 50, offset = 0 } = {}) {
    const rows = await _db.query(
      `SELECT
         i.*,
         c.NAME  AS CONTAINER_NAME,
         a.NAME  AS AREA_NAME,
         pr.NAME AS PROPERTY_NAME,
         DATEDIFF(DATE_ADD(i.DELETED_AT, INTERVAL 30 DAY), NOW()) AS DAYS_LEFT
       FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID
       JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID
       WHERE i.DELETED_AT IS NOT NULL
         AND i.DELETED_AT > DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND pm.USER_ID = ?
       ORDER BY i.DELETED_AT DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    return rows.map(row => ({
      ...ItemsService._mapItem(row),
      containerName: row.CONTAINER_NAME || null,
      areaName: row.AREA_NAME || null,
      propertyName: row.PROPERTY_NAME || null,
      daysLeft: row.DAYS_LEFT != null ? Number(row.DAYS_LEFT) : 0,
    }));
  },

  async permanentDelete(itemId) {
    // Collect the object-storage keys BEFORE the transaction so we can remove
    // them only AFTER the DB delete commits — removing them up front (as the
    // old code did) would orphan data if the transaction later rolled back.
    const snapshots = await _db.query(
      `SELECT PHOTO_KEY FROM TALLY.condition_snapshots WHERE ITEM_ID = ?`,
      [itemId]
    );
    const files = await _db.query(
      `SELECT FILE_KEY FROM TALLY.item_files WHERE ITEM_ID = ?`,
      [itemId]
    );

    // All dependent-table deletes + the item hard-delete commit as one unit,
    // so a failure can't leave dangling child rows (or a half-deleted item).
    await _db.withTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM TALLY.entity_tags WHERE ENTITY_TYPE = 'item' AND ENTITY_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_accessories WHERE ITEM_ID = ? OR ACCESSORY_ID = ?`,
        [itemId, itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_dates WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_lending WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.condition_snapshots WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.item_files WHERE ITEM_ID = ?`,
        [itemId]
      );
      await tx.query(
        `DELETE FROM TALLY.items WHERE ID = ?`,
        [itemId]
      );
    });

    // Best-effort object cleanup after the DB delete is durable.
    for (const snap of snapshots) {
      try { await storage.remove(snap.PHOTO_KEY); } catch { /* ignore */ }
    }
    for (const f of files) {
      try { await storage.remove(f.FILE_KEY); } catch { /* ignore */ }
    }
  },

  async purgeExpired(userId) {
    const rows = await _db.query(
      `SELECT i.ID FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.property_members pm ON a.PROPERTY_ID = pm.PROPERTY_ID
       WHERE i.DELETED_AT IS NOT NULL
         AND i.DELETED_AT < DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND pm.USER_ID = ? AND pm.ROLE = 'owner'
         AND NOT EXISTS (
           SELECT 1 FROM TALLY.item_lending il
           WHERE il.ITEM_ID = i.ID AND il.RETURNED_AT IS NULL
         )`,
      [userId]
    );
    // Items with an open loan are skipped above so the purge can't destroy an
    // active loan record (defense in depth — softDelete already blocks
    // deleting a lent item, but pre-existing recycled rows may still have one).
    for (const row of rows) {
      await ItemsService.permanentDelete(row.ID);
    }
    return rows.length;
  },
};

module.exports = ItemsService;
