CREATE TABLE artist_index (
  artist_key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE artist_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  through_at INTEGER,
  cutoff_at INTEGER,
  next_page INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO artist_sync (id) VALUES (1);
