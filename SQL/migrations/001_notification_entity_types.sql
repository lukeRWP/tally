-- Allow date- and lending-based notifications to reference their source row.
--
-- checkDateNotifications() inserts notifications with ENTITY_TYPE 'item_date'
-- (an item_dates row) or 'item_lending' (an item_lending row), but the column
-- ENUM only permitted property/area/container/item. Under STRICT sql_mode the
-- INSERT failed, and a single outer try/catch swallowed it and aborted the
-- whole notification pass — so date and lending-due notifications could never
-- be created. This adds the two missing values.
--
-- No `USE` statement: the migrate-all playbook selects the app's main DB
-- (`mysql -D TALLY`). Table name unqualified to match SQL/init.
ALTER TABLE notifications
  MODIFY ENTITY_TYPE
    ENUM('property','area','container','item','item_date','item_lending') NULL;
