-- File metadata cache
-- Stores S3 object metadata for instant folder listings
CREATE TABLE IF NOT EXISTS file_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket TEXT NOT NULL,
    key TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    last_modified TEXT,
    is_dir INTEGER NOT NULL DEFAULT 0,
    cached_at INTEGER NOT NULL,
    UNIQUE(bucket, key)
);

-- Index for fast folder listings (prefix queries)
CREATE INDEX IF NOT EXISTS idx_file_cache_prefix ON file_cache(bucket, key);

-- Index for TTL cleanup
CREATE INDEX IF NOT EXISTS idx_file_cache_cached_at ON file_cache(cached_at);

-- Folder sync tracking
-- Tracks when each folder was last synchronized with S3
CREATE TABLE IF NOT EXISTS folder_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket TEXT NOT NULL,
    prefix TEXT NOT NULL,
    last_sync INTEGER NOT NULL,
    item_count INTEGER,
    UNIQUE(bucket, prefix)
);

-- Index for quick sync status lookups
CREATE INDEX IF NOT EXISTS idx_folder_sync_lookup ON folder_sync(bucket, prefix);
