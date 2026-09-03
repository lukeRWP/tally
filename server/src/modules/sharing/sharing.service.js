const crypto = require('crypto');
const storage = require('../../infrastructure/storage');
const disclosure = require('./sharing.disclosure');

let _db = null;
let _logger = null;
let _baseUrl = null;

// share_links records the entity a link points at, not the property that
// owns it, and three of the four entity types are some joins away from a
// PROPERTY_ID. Every read that needs to know "whose property is this link
// on" — owner visibility, owner revoke, the creator-still-a-member check —
// walks the same chain, so it is written once. Aliases are prefixed `l` so
// the fragment can sit beside the other joins a query already carries.
const LINK_PROPERTY_JOINS = `
       LEFT JOIN TALLY.areas la ON s.ENTITY_TYPE = 'area' AND la.ID = s.ENTITY_ID
       LEFT JOIN TALLY.containers lc ON s.ENTITY_TYPE = 'container' AND lc.ID = s.ENTITY_ID
       LEFT JOIN TALLY.areas lca ON lca.ID = lc.AREA_ID
       LEFT JOIN TALLY.items li ON s.ENTITY_TYPE = 'item' AND li.ID = s.ENTITY_ID
       LEFT JOIN TALLY.containers lic ON lic.ID = li.CONTAINER_ID
       LEFT JOIN TALLY.areas lia ON lia.ID = lic.AREA_ID`;
const LINK_PROPERTY_ID = `COALESCE(
         CASE WHEN s.ENTITY_TYPE = 'property' THEN s.ENTITY_ID END,
         la.PROPERTY_ID, lca.PROPERTY_ID, lia.PROPERTY_ID)`;

// Never TOKEN. After #349 the column holds a digest, which is useless to a
// client and still a secret worth not echoing; before it, the raw credential.
const LINK_COLUMNS = 's.ID, s.ENTITY_TYPE, s.ENTITY_ID, s.CREATED_BY, s.EXPIRES_AT, s.CREATED_AT, s.DISCLOSURE';

const SharingService = {
  // ── Initialization ─────────────────────────────────────────────────────────

  init({ db, logger, config }) {
    _db = db;
    _logger = logger;
    _baseUrl = config.clientUrl;
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * What the table holds for a token (#349). The raw value is the whole
   * credential for a public page, so it lives only in the URL handed back by
   * create(); the row keeps its digest, and validate() digests what arrives.
   * Node's sha256 hex and MySQL's SHA2(x, 256) agree for these ASCII tokens,
   * which is what lets migration 014 rewrite the old rows in place.
   */
  _hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  },

  _mapLink(row) {
    return {
      id: row.ID,
      entityType: row.ENTITY_TYPE,
      entityId: row.ENTITY_ID,
      propertyId: row.PROPERTY_ID ?? null,
      createdBy: row.CREATED_BY,
      createdByName: row.CREATED_BY_NAME ?? null,
      expiresAt: row.EXPIRES_AT,
      createdAt: row.CREATED_AT,
      // Resolved, never raw: a NULL column and an all-true object are the same
      // link, and the dialog should not have to know that.
      disclosure: disclosure.resolve(row.DISCLOSURE, row.ENTITY_TYPE),
    };
  },

  // ── CRUD ───────────────────────────────────────────────────────────────────

  /**
   * `choices` is the sharer's per-link disclosure (see sharing.disclosure.js).
   * Omitted, or all-defaults, stores NULL — a row indistinguishable from every
   * link created before the column existed, publishing exactly the same thing.
   *
   * The returned link carries `url` — the only time the raw token leaves the
   * server. No later read can rebuild it (#349), so the dialog shows it once.
   */
  async create(entityType, entityId, createdBy, expiresInDays = 7, choices = null) {
    const token = crypto.randomBytes(32).toString('hex');
    const chosen = disclosure.normalizeChoice(choices, entityType);

    const result = await _db.query(
      `INSERT INTO TALLY.share_links (TOKEN, TOKEN_HASHED, ENTITY_TYPE, ENTITY_ID, CREATED_BY, EXPIRES_AT, DISCLOSURE)
       VALUES (?, 1, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
      // Stringified explicitly: mysql2 escapes a bare object as `k = v` pairs,
      // which is not JSON and not what a JSON column wants.
      [SharingService._hashToken(token), entityType, entityId, createdBy, expiresInDays, chosen ? JSON.stringify(chosen) : null]
    );

    const rows = await _db.query(
      `SELECT ${LINK_COLUMNS}, ${LINK_PROPERTY_ID} AS PROPERTY_ID, u.DISPLAY_NAME AS CREATED_BY_NAME
       FROM TALLY.share_links s
       ${LINK_PROPERTY_JOINS}
       LEFT JOIN TALLY.users u ON u.ID = s.CREATED_BY
       WHERE s.ID = ?`,
      [result.insertId]
    );

    return { ...SharingService._mapLink(rows[0]), url: `${_baseUrl}/share/${token}` };
  },

  async validate(token) {
    // The public page has to frame itself for a stranger — who shared this and
    // when it stops working — so the sharer's display name is joined in here.
    //
    // The property_members join is the membership recheck (#349): a link is
    // only as good as its creator's standing on the property it exposes. An
    // editor who is removed takes their links with them, and a creator whose
    // account is gone has no membership row either, so the users join can be
    // inner — every row that survives the recheck has a sharer to name.
    //
    // TOKEN_HASHED = 1 is deliberate, not belt-and-braces: a row the old
    // server wrote between migration 014 and this code deploying holds a raw
    // token, and matching a raw token against a digest would be a lie that
    // happens to fail. Such a row is simply dead until the expiry purge.
    const rows = await _db.query(
      `SELECT s.ENTITY_TYPE, s.ENTITY_ID, s.CREATED_BY, s.EXPIRES_AT, s.CREATED_AT, s.DISCLOSURE,
              u.DISPLAY_NAME AS CREATED_BY_NAME
       FROM TALLY.share_links s
       ${LINK_PROPERTY_JOINS}
       JOIN TALLY.property_members pm ON pm.PROPERTY_ID = ${LINK_PROPERTY_ID} AND pm.USER_ID = s.CREATED_BY
       JOIN TALLY.users u ON u.ID = s.CREATED_BY
       WHERE s.TOKEN = ? AND s.TOKEN_HASHED = 1 AND s.EXPIRES_AT > NOW()`,
      [SharingService._hashToken(token)]
    );
    if (!rows.length) return null;

    const row = rows[0];
    return {
      entityType: row.ENTITY_TYPE,
      entityId: row.ENTITY_ID,
      createdBy: row.CREATED_BY,
      createdByName: row.CREATED_BY_NAME || null,
      expiresAt: row.EXPIRES_AT || null,
      createdAt: row.CREATED_AT || null,
      // Raw here on purpose — the public route hands it straight back to
      // applyDisclosure(), which is the only thing entitled to interpret it.
      disclosure: row.DISCLOSURE ?? null,
    };
  },

  /**
   * Every link this user is entitled to see (#349): the ones they created,
   * plus every link on a property they own, whoever created it. Before this
   * an owner could not see — let alone revoke — a link an editor had made,
   * and the link outlived the editor's membership.
   *
   * Expired rows are purged first. Nothing else ever deleted them; validate()
   * ignored them, but they still counted in the Settings header and still
   * held a token that no longer opened anything.
   */
  async getByUser(userId) {
    await _db.query('DELETE FROM TALLY.share_links WHERE EXPIRES_AT <= NOW()');

    const rows = await _db.query(
      `SELECT ${LINK_COLUMNS}, ${LINK_PROPERTY_ID} AS PROPERTY_ID, u.DISPLAY_NAME AS CREATED_BY_NAME
       FROM TALLY.share_links s
       ${LINK_PROPERTY_JOINS}
       LEFT JOIN TALLY.users u ON u.ID = s.CREATED_BY
       LEFT JOIN TALLY.property_members pm ON pm.PROPERTY_ID = ${LINK_PROPERTY_ID} AND pm.USER_ID = ?
       WHERE s.CREATED_BY = ? OR pm.ROLE = 'owner'
       ORDER BY s.CREATED_AT DESC`,
      [userId, userId]
    );
    return rows.map(SharingService._mapLink);
  },

  /** Creator or property owner. Resolves to whether a row was actually removed. */
  async revoke(linkId, userId) {
    const result = await _db.query(
      `DELETE s FROM TALLY.share_links s
       ${LINK_PROPERTY_JOINS}
       LEFT JOIN TALLY.property_members pm ON pm.PROPERTY_ID = ${LINK_PROPERTY_ID} AND pm.USER_ID = ?
       WHERE s.ID = ? AND (s.CREATED_BY = ? OR pm.ROLE = 'owner')`,
      [userId, linkId, userId]
    );
    return (result?.affectedRows ?? 0) > 0;
  },

  // ── Public entity fetching ─────────────────────────────────────────────────

  /**
   * The whole public payload. `storedDisclosure` is the raw share_links column
   * for this link; the strip runs here, after the envelope is built, so there
   * is exactly one place where a sharer's "no" is honoured and no query edit
   * can route around it. Omitted (or NULL) publishes everything — the
   * behaviour of every link created before #298.
   */
  async getEntityForShare(entityType, entityId, storedDisclosure = null) {
    let envelope;
    switch (entityType) {
      case 'property':
        envelope = await SharingService._getPropertyForShare(entityId);
        break;
      case 'area':
        envelope = await SharingService._getAreaForShare(entityId);
        break;
      case 'container':
        envelope = await SharingService._getContainerForShare(entityId);
        break;
      case 'item':
        envelope = await SharingService._getItemForShare(entityId);
        break;
      default:
        return null;
    }
    return envelope ? disclosure.applyDisclosure(envelope, storedDisclosure) : null;
  },

  async _getPropertyForShare(propertyId) {
    // Property details
    const propRows = await _db.query(
      'SELECT ID, NAME, ADDRESS, DESCRIPTION, CREATED_AT FROM TALLY.properties WHERE ID = ? AND DELETED_AT IS NULL',
      [propertyId]
    );
    if (!propRows.length) return null;
    const prop = propRows[0];

    // All areas
    const areaRows = await _db.query(
      'SELECT ID, NAME, DESCRIPTION, QR_CODE, CREATED_AT FROM TALLY.areas WHERE PROPERTY_ID = ? AND DELETED_AT IS NULL ORDER BY NAME',
      [propertyId]
    );

    // All containers for this property
    const containerRows = await _db.query(
      `SELECT c.ID, c.AREA_ID, c.PARENT_CONTAINER_ID, c.NAME, c.TYPE, c.DESCRIPTION, c.QR_CODE, c.CREATED_AT
       FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       WHERE a.PROPERTY_ID = ? AND c.DELETED_AT IS NULL
       ORDER BY c.NAME`,
      [propertyId]
    );

    // All items for this property
    const itemRows = await _db.query(
      `SELECT i.ID, i.CONTAINER_ID, i.NAME, i.DESCRIPTION, i.QUANTITY,
              i.\`CONDITION\`, i.STATUS, i.QR_CODE, i.CREATED_AT,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL
       FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE a.PROPERTY_ID = ? AND i.DELETED_AT IS NULL
       ORDER BY i.NAME`,
      [propertyId]
    );

    return {
      type: 'property',
      property: {
        id: prop.ID,
        name: prop.NAME,
        address: prop.ADDRESS || null,
        description: prop.DESCRIPTION || null,
        createdAt: prop.CREATED_AT,
      },
      areas: areaRows.map(a => ({
        id: a.ID,
        name: a.NAME,
        description: a.DESCRIPTION || null,
        qrCode: a.QR_CODE || null,
        createdAt: a.CREATED_AT,
      })),
      containers: containerRows.map(c => ({
        id: c.ID,
        areaId: c.AREA_ID,
        parentContainerId: c.PARENT_CONTAINER_ID || null,
        name: c.NAME,
        type: c.TYPE || null,
        description: c.DESCRIPTION || null,
        qrCode: c.QR_CODE || null,
        createdAt: c.CREATED_AT,
      })),
      // NO purchasePrice (#298). It used to ride on every item of a whole-
      // property share — the household's spend on everything it owns, to
      // anyone holding the URL — and the share page has never rendered it:
      // `ItemLine` in share-view.tsx draws name, condition, description and
      // quantity, and nothing else. An item share still carries its own price,
      // because `ItemView` genuinely shows it.
      items: itemRows.map(i => ({
        id: i.ID,
        containerId: i.CONTAINER_ID,
        name: i.NAME,
        description: i.DESCRIPTION || null,
        quantity: i.QUANTITY != null ? Number(i.QUANTITY) : 1,
        condition: i.CONDITION || null,
        status: i.STATUS || null,
        qrCode: i.QR_CODE || null,
        createdAt: i.CREATED_AT,
        productName: i.PRODUCT_NAME || null,
        productBrand: i.PRODUCT_BRAND || null,
        productImageUrl: i.PRODUCT_IMAGE_URL || null,
      })),
    };
  },

  async _getAreaForShare(areaId) {
    // Area + property name
    const areaRows = await _db.query(
      `SELECT a.ID, a.PROPERTY_ID, a.NAME, a.DESCRIPTION, a.QR_CODE, a.CREATED_AT,
              p.NAME AS PROPERTY_NAME
       FROM TALLY.areas a
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       WHERE a.ID = ? AND a.DELETED_AT IS NULL`,
      [areaId]
    );
    if (!areaRows.length) return null;
    const area = areaRows[0];

    // Containers within this area
    const containerRows = await _db.query(
      `SELECT ID, PARENT_CONTAINER_ID, NAME, TYPE, DESCRIPTION, QR_CODE, CREATED_AT
       FROM TALLY.containers
       WHERE AREA_ID = ? AND DELETED_AT IS NULL
       ORDER BY NAME`,
      [areaId]
    );

    // Items within this area
    const itemRows = await _db.query(
      `SELECT i.ID, i.CONTAINER_ID, i.NAME, i.DESCRIPTION, i.QUANTITY,
              i.\`CONDITION\`, i.STATUS, i.QR_CODE, i.CREATED_AT,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL
       FROM TALLY.items i
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE c.AREA_ID = ? AND i.DELETED_AT IS NULL
       ORDER BY i.NAME`,
      [areaId]
    );

    return {
      type: 'area',
      area: {
        id: area.ID,
        propertyId: area.PROPERTY_ID,
        propertyName: area.PROPERTY_NAME || null,
        name: area.NAME,
        description: area.DESCRIPTION || null,
        qrCode: area.QR_CODE || null,
        createdAt: area.CREATED_AT,
      },
      containers: containerRows.map(c => ({
        id: c.ID,
        parentContainerId: c.PARENT_CONTAINER_ID || null,
        name: c.NAME,
        type: c.TYPE || null,
        description: c.DESCRIPTION || null,
        qrCode: c.QR_CODE || null,
        createdAt: c.CREATED_AT,
      })),
      items: itemRows.map(i => ({
        id: i.ID,
        containerId: i.CONTAINER_ID,
        name: i.NAME,
        description: i.DESCRIPTION || null,
        quantity: i.QUANTITY != null ? Number(i.QUANTITY) : 1,
        condition: i.CONDITION || null,
        status: i.STATUS || null,
        qrCode: i.QR_CODE || null,
        createdAt: i.CREATED_AT,
        productName: i.PRODUCT_NAME || null,
        productBrand: i.PRODUCT_BRAND || null,
        productImageUrl: i.PRODUCT_IMAGE_URL || null,
      })),
    };
  },

  async _getContainerForShare(containerId) {
    // Container + area/property breadcrumb
    const containerRows = await _db.query(
      `SELECT c.ID, c.AREA_ID, c.PARENT_CONTAINER_ID, c.NAME, c.TYPE, c.DESCRIPTION, c.QR_CODE, c.CREATED_AT,
              a.NAME AS AREA_NAME, a.PROPERTY_ID AS PROPERTY_ID,
              p.NAME AS PROPERTY_NAME
       FROM TALLY.containers c
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties p ON a.PROPERTY_ID = p.ID
       WHERE c.ID = ? AND c.DELETED_AT IS NULL`,
      [containerId]
    );
    if (!containerRows.length) return null;
    const cont = containerRows[0];

    // Nested containers via closure table (all descendants)
    const nestedRows = await _db.query(
      `SELECT c.ID, c.AREA_ID, c.PARENT_CONTAINER_ID, c.NAME, c.TYPE, c.DESCRIPTION, c.QR_CODE, c.CREATED_AT,
              cp.DEPTH
       FROM TALLY.container_paths cp
       JOIN TALLY.containers c ON cp.DESCENDANT_ID = c.ID
       WHERE cp.ANCESTOR_ID = ? AND cp.DEPTH > 0 AND c.DELETED_AT IS NULL
       ORDER BY cp.DEPTH ASC, c.NAME ASC`,
      [containerId]
    );

    // All items within this container and its descendants
    const itemRows = await _db.query(
      `SELECT i.ID, i.CONTAINER_ID, i.NAME, i.DESCRIPTION, i.QUANTITY,
              i.\`CONDITION\`, i.STATUS, i.QR_CODE, i.CREATED_AT,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL
       FROM TALLY.items i
       JOIN TALLY.container_paths cp ON i.CONTAINER_ID = cp.DESCENDANT_ID
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       WHERE cp.ANCESTOR_ID = ? AND i.DELETED_AT IS NULL
       ORDER BY i.NAME`,
      [containerId]
    );

    return {
      type: 'container',
      container: {
        id: cont.ID,
        areaId: cont.AREA_ID,
        areaName: cont.AREA_NAME || null,
        propertyId: cont.PROPERTY_ID || null,
        propertyName: cont.PROPERTY_NAME || null,
        parentContainerId: cont.PARENT_CONTAINER_ID || null,
        name: cont.NAME,
        type: cont.TYPE || null,
        description: cont.DESCRIPTION || null,
        qrCode: cont.QR_CODE || null,
        createdAt: cont.CREATED_AT,
      },
      nestedContainers: nestedRows.map(c => ({
        id: c.ID,
        areaId: c.AREA_ID,
        parentContainerId: c.PARENT_CONTAINER_ID || null,
        name: c.NAME,
        type: c.TYPE || null,
        description: c.DESCRIPTION || null,
        qrCode: c.QR_CODE || null,
        depth: c.DEPTH,
        createdAt: c.CREATED_AT,
      })),
      items: itemRows.map(i => ({
        id: i.ID,
        containerId: i.CONTAINER_ID,
        name: i.NAME,
        description: i.DESCRIPTION || null,
        quantity: i.QUANTITY != null ? Number(i.QUANTITY) : 1,
        condition: i.CONDITION || null,
        status: i.STATUS || null,
        qrCode: i.QR_CODE || null,
        createdAt: i.CREATED_AT,
        productName: i.PRODUCT_NAME || null,
        productBrand: i.PRODUCT_BRAND || null,
        productImageUrl: i.PRODUCT_IMAGE_URL || null,
      })),
    };
  },

  async _getItemForShare(itemId) {
    // Item + product info + container/area/property breadcrumb
    const itemRows = await _db.query(
      `SELECT i.*,
              p.NAME AS PRODUCT_NAME, p.BRAND AS PRODUCT_BRAND, p.IMAGE_URL AS PRODUCT_IMAGE_URL,
              p.DESCRIPTION AS PRODUCT_DESCRIPTION,
              c.NAME AS CONTAINER_NAME,
              a.ID AS AREA_ID, a.NAME AS AREA_NAME,
              a.PROPERTY_ID AS PROPERTY_ID, pr.NAME AS PROPERTY_NAME
       FROM TALLY.items i
       LEFT JOIN TALLY.products p ON i.PRODUCT_ID = p.ID
       JOIN TALLY.containers c ON i.CONTAINER_ID = c.ID
       JOIN TALLY.areas a ON c.AREA_ID = a.ID
       JOIN TALLY.properties pr ON a.PROPERTY_ID = pr.ID
       WHERE i.ID = ? AND i.DELETED_AT IS NULL`,
      [itemId]
    );
    if (!itemRows.length) return null;
    const row = itemRows[0];

    // Condition snapshots with presigned photo URLs.
    //
    // NO recordedByName, and no users join to produce one (#298). It published
    // a second household member's display name on an unauthenticated page they
    // never agreed to be on, and nothing renders it: `recordedByName` appears
    // in exactly one component, condition-timeline.tsx, which lives on the
    // AUTHENTICATED item page (item-detail.tsx) and is not imported by
    // share-view.tsx — that page normalises `conditionSnapshots` into the
    // entity and never draws a field off it. The authenticated history
    // (files/condition.service.js) still returns the name, because there the
    // reader is a fellow property member and the timeline shows it.
    //
    // Dropping the LEFT JOIN means the public route no longer reads
    // TALLY.users for snapshots at all — the name cannot leak back by someone
    // re-adding a mapped field alone.
    const snapshotRows = await _db.query(
      `SELECT cs.ID, cs.CONDITION, cs.PHOTO_KEY, cs.NOTES, cs.CREATED_AT
       FROM TALLY.condition_snapshots cs
       WHERE cs.ITEM_ID = ?
       ORDER BY cs.CREATED_AT DESC`,
      [itemId]
    );

    const conditionSnapshots = await Promise.all(
      snapshotRows.map(async (snap) => ({
        id: snap.ID,
        condition: snap.CONDITION,
        notes: snap.NOTES || null,
        createdAt: snap.CREATED_AT,
        photoUrl: await storage.getPresignedUrl(snap.PHOTO_KEY, { expiresIn: 300, inline: true }),
      }))
    );

    // Item files with presigned URLs
    const fileRows = await _db.query(
      `SELECT ID, FILE_TYPE, FILE_KEY, FILE_NAME, MIME_TYPE, FILE_SIZE, CREATED_AT
       FROM TALLY.item_files
       WHERE ITEM_ID = ?
       ORDER BY CREATED_AT DESC`,
      [itemId]
    );

    const files = await Promise.all(
      fileRows.map(async (f) => ({
        id: f.ID,
        fileType: f.FILE_TYPE,
        fileName: f.FILE_NAME,
        mimeType: f.MIME_TYPE,
        fileSize: f.FILE_SIZE,
        createdAt: f.CREATED_AT,
        url: await storage.getPresignedUrl(f.FILE_KEY, { expiresIn: 300, contentType: f.MIME_TYPE, fileName: f.FILE_NAME }),
      }))
    );

    // Item dates
    const dateRows = await _db.query(
      'SELECT ID, DATE_TYPE, DATE_VALUE, NOTES FROM TALLY.item_dates WHERE ITEM_ID = ? ORDER BY DATE_VALUE ASC',
      [itemId]
    );

    return {
      type: 'item',
      item: {
        id: row.ID,
        name: row.NAME,
        description: row.DESCRIPTION || null,
        quantity: row.QUANTITY != null ? Number(row.QUANTITY) : 1,
        purchasePrice: row.PURCHASE_PRICE != null ? Number(row.PURCHASE_PRICE) : null,
        condition: row.CONDITION || null,
        status: row.STATUS || null,
        qrCode: row.QR_CODE || null,
        // NO depreciationEnabled / depreciationRate (#298): the household's
        // valuation model, and share-view.tsx names neither. Depreciation is
        // computed client-side on the authenticated item page (item-detail.tsx),
        // which is where those two fields are read.
        createdAt: row.CREATED_AT,
        updatedAt: row.UPDATED_AT,
        // Product info
        productName: row.PRODUCT_NAME || null,
        productBrand: row.PRODUCT_BRAND || null,
        productImageUrl: row.PRODUCT_IMAGE_URL || null,
        productDescription: row.PRODUCT_DESCRIPTION || null,
        // NO productSpecs (#298): a free-form JSON blob shipped whole to an
        // anonymous viewer, and `productOf()` in share-view.tsx builds its
        // product object from name/brand/imageUrl/description only.
        // Breadcrumb
        breadcrumb: [
          { id: row.PROPERTY_ID, name: row.PROPERTY_NAME || null, type: 'property' },
          { id: row.AREA_ID, name: row.AREA_NAME || null, type: 'area' },
          { id: row.CONTAINER_ID, name: row.CONTAINER_NAME || null, type: 'container' },
        ],
      },
      conditionSnapshots,
      files,
      dates: dateRows.map(d => ({
        id: d.ID,
        dateType: d.DATE_TYPE,
        dateValue: d.DATE_VALUE,
        notes: d.NOTES || null,
      })),
    };
  },
};

module.exports = SharingService;
