-- History: each event as received, duplicates included.
-- The service creates one partition per day (UTC) at startup.
CREATE TABLE event_history (
  received_at    timestamptz NOT NULL,
  event_id       text NOT NULL,
  event_type     text NOT NULL,
  schema_version int  NOT NULL,
  charger_id     text NOT NULL,
  connector_id   int  NOT NULL,
  event_time     timestamptz NOT NULL,
  payload        jsonb NOT NULL
) PARTITION BY RANGE (received_at);

-- Latest state: one row for each charger, connector, and field group.
CREATE TABLE latest_state (
  charger_id   text NOT NULL,
  connector_id int  NOT NULL,
  field_group  text NOT NULL,
  event_time   timestamptz NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL,
  data         jsonb NOT NULL,
  PRIMARY KEY (charger_id, connector_id, field_group)
);
