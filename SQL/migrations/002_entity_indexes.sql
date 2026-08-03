-- Indexes for entity-scoped lookups that currently full-scan.
--
-- change_log: the only index led with (PROPERTY_ID, CREATED_AT), so the
-- entity-history endpoint (GET /api/audit/_x_/entity/:type/:id) full-scanned
-- the fastest-growing table. change_log is append-only, so an added key is cheap.
--
-- entity_tags: the only index is UNIQUE (TAG_ID, ENTITY_TYPE, ENTITY_ID) — its
-- leading column is TAG_ID, so a lookup BY an entity (getForEntity, the
-- tag-filtered item search join) could not seek and scanned the table.
--
-- No `USE` statement — the migrate-all playbook selects the app DB (-D TALLY).
ALTER TABLE change_log  ADD KEY idx_change_log_entity  (ENTITY_TYPE, ENTITY_ID, CREATED_AT);
ALTER TABLE entity_tags ADD KEY idx_entity_tags_entity (ENTITY_TYPE, ENTITY_ID);
