class ClosureTableService {
  constructor(db) {
    this.db = db;
  }

  // Insert self-reference + copy ancestor paths.
  // `executor` lets the caller run these writes inside an open transaction.
  async addNode(containerId, parentContainerId, executor = this.db) {
    // Self-reference: every node is its own ancestor at depth 0
    await executor.query(
      'INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH) VALUES (?, ?, 0)',
      [containerId, containerId]
    );

    if (parentContainerId) {
      // Copy all ancestors of parent, incrementing depth by 1
      await executor.query(
        `INSERT INTO TALLY.container_paths (ANCESTOR_ID, DESCENDANT_ID, DEPTH)
         SELECT ANCESTOR_ID, ?, DEPTH + 1
         FROM TALLY.container_paths
         WHERE DESCENDANT_ID = ?`,
        [containerId, parentContainerId]
      );
    }
  }

  // Move a subtree: delete old ancestor paths, insert new ones.
  // Reads and writes all run through `executor` so a transactional caller
  // sees its own uncommitted changes.
  //
  // CONCURRENCY PRECONDITION (#252): Step 3 replays the IN-lists Steps 1/2
  // materialized as a DELETE against CURRENT state, so this is only safe
  // while both lists are frozen — the caller must hold FOR UPDATE locks on
  // the mover's ENTIRE subtree (which pins the descendant list AND, because
  // any move that could change this node's ancestors carries this node in
  // its own locked subtree, the ancestor list too) for the duration of the
  // transaction. containers.service.move() is the only caller and takes
  // exactly that lock set in its statement-0 ascending-ID lock, re-verified
  // post-lock. Without it, two overlapping-subtree moves with disjoint lock
  // sets could each replay stale lists and Step 3 would delete closure rows
  // the partner had just inserted — a silently lost ancestry edge.
  async moveNode(containerId, newParentContainerId, executor = this.db) {
    // Step 1: Get all descendants of the node being moved (including self)
    const descendants = await executor.query(
      'SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?',
      [containerId]
    );
    const descendantIds = descendants.map(r => r.DESCENDANT_ID);

    // Step 2: Get all ancestors of the node being moved (excluding self and its subtree)
    const ancestors = await executor.query(
      'SELECT ANCESTOR_ID FROM TALLY.container_paths WHERE DESCENDANT_ID = ? AND ANCESTOR_ID != ?',
      [containerId, containerId]
    );
    const ancestorIds = ancestors.map(r => r.ANCESTOR_ID);

    // Step 3: Delete paths connecting old ancestors to the subtree
    if (ancestorIds.length > 0 && descendantIds.length > 0) {
      await executor.query(
        `DELETE FROM TALLY.container_paths
         WHERE ANCESTOR_ID IN (${ancestorIds.map(() => '?').join(',')})
         AND DESCENDANT_ID IN (${descendantIds.map(() => '?').join(',')})`,
        [...ancestorIds, ...descendantIds]
      );
    }

    // Step 4: Insert new paths from new parent's ancestors to the subtree
    if (newParentContainerId) {
      await executor.query(
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
  async removeNode(containerId, executor = this.db) {
    const descendants = await executor.query(
      'SELECT DESCENDANT_ID FROM TALLY.container_paths WHERE ANCESTOR_ID = ?',
      [containerId]
    );
    const ids = descendants.map(r => r.DESCENDANT_ID);
    if (ids.length > 0) {
      await executor.query(
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
