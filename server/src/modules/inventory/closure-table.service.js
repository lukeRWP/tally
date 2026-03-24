class ClosureTableService {
  constructor(db) {
    this.db = db;
  }

  // Insert self-reference + copy ancestor paths
  async addNode(containerId, parentContainerId) {
    // Self-reference: every node is its own ancestor at depth 0
    await this.db.query(
      'INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH) VALUES (?, ?, 0)',
      [containerId, containerId]
    );

    if (parentContainerId) {
      // Copy all ancestors of parent, incrementing depth by 1
      await this.db.query(
        `INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH)
         SELECT ANCESTOR_ID, ?, DEPTH + 1
         FROM TALLY.container_paths
         WHERE DESCENDANT_ID = ?`,
        [containerId, parentContainerId]
      );
    }
  }

  // Move a subtree: delete old ancestor paths, insert new ones
  async moveNode(containerId, newParentContainerId) {
    // Step 1: Get all descendants of the node being moved (including self)
    const descendants = await this.db.query(
      'SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?',
      [containerId]
    );
    const descendantIds = descendants.map(r => r.DESCENDANT_ID);

    // Step 2: Get all ancestors of the node being moved (excluding self and its subtree)
    const ancestors = await this.db.query(
      'SELECT ANCESTOR_ID FROM TALLY.container_paths WHERE DESCENDANT_ID = ? AND ANCESTOR_ID != ?',
      [containerId, containerId]
    );
    const ancestorIds = ancestors.map(r => r.ANCESTOR_ID);

    // Step 3: Delete paths connecting old ancestors to the subtree
    if (ancestorIds.length > 0 && descendantIds.length > 0) {
      await this.db.query(
        `DELETE FROM TALLY.container_paths
         WHERE ANCESTOR_ID IN (${ancestorIds.map(() => '?').join(',')})
         AND DESCENDANT_ID IN (${descendantIds.map(() => '?').join(',')})`,
        [...ancestorIds, ...descendantIds]
      );
    }

    // Step 4: Insert new paths from new parent's ancestors to the subtree
    if (newParentContainerId) {
      await this.db.query(
        `INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH)
         SELECT ancestor.ANCESTOR_ID, subtree.DESCENDANT_ID, ancestor.DEPTH + subtree.DEPTH + 1
         FROM TALLY.container_paths ancestor
         CROSS JOIN TALLY.container_paths subtree
         WHERE ancestor.DESCENDANT_ID = ? AND subtree.ANCESTOR_ID = ?`,
        [newParentContainerId, containerId]
      );
    }
  }

  // Remove node and all descendants from closure table
  async removeNode(containerId) {
    const descendants = await this.db.query(
      'SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?',
      [containerId]
    );
    const ids = descendants.map(r => r.DESCENDANT_ID);
    if (ids.length > 0) {
      await this.db.query(
        `DELETE FROM TALLY.container_paths WHERE DESCENDANT_ID IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    }
  }

  // Get all descendant container IDs (for "what's inside this?")
  async getDescendants(containerId) {
    return this.db.query(
      'SELECT DESCENDANT_ID, DEPTH FROM TALLY.container_paths WHERE ANCESTOR_ID = ? AND DEPTH > 0 ORDER BY DEPTH',
      [containerId]
    );
  }

  // Get ancestor path (for breadcrumbs)
  async getAncestors(containerId) {
    return this.db.query(
      'SELECT ANCESTOR_ID, DEPTH FROM TALLY.container_paths WHERE DESCENDANT_ID = ? AND DEPTH > 0 ORDER BY DEPTH DESC',
      [containerId]
    );
  }
}

module.exports = ClosureTableService;
