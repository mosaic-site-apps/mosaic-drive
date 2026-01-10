// SQLite-based file metadata cache for instant folder listings

use rusqlite::{Connection, params};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

// Cache TTL in seconds (5 minutes)
pub const CACHE_TTL_SECONDS: i64 = 300;

// Global database connection wrapped in Mutex for thread safety
static DB: std::sync::OnceLock<Mutex<Connection>> = std::sync::OnceLock::new();

#[derive(Clone, Serialize, Debug)]
pub struct CachedFileObject {
    pub key: String,
    pub size: i64,
    pub last_modified: String,
    pub is_dir: bool,
}

#[derive(Clone, Serialize, Debug)]
pub struct CacheStatus {
    pub is_fresh: bool,
    pub last_sync: Option<i64>,
    pub item_count: i64,
}

#[derive(Clone, Serialize, Debug)]
pub struct ListResult {
    pub files: Vec<CachedFileObject>,
    pub from_cache: bool,
    pub cache_status: CacheStatus,
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Get the database path in the app data directory
fn get_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure the directory exists
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("mosaic_cache.db"))
}

/// Initialize the database with schema
pub fn init_database(app: &AppHandle) -> Result<(), String> {
    let db_path = get_db_path(app)?;
    println!("DEBUG: Initializing cache database at {:?}", db_path);

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open database: {}", e))?;

    // Create tables
    conn.execute_batch(include_str!("../migrations/001_initial.sql"))
        .map_err(|e| format!("Failed to run migrations: {}", e))?;

    // Store the connection globally
    DB.set(Mutex::new(conn))
        .map_err(|_| "Database already initialized".to_string())?;

    println!("DEBUG: Cache database initialized successfully");
    Ok(())
}

/// Get the database connection
fn get_db() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    DB.get()
        .ok_or_else(|| "Database not initialized".to_string())?
        .lock()
        .map_err(|e| format!("Failed to lock database: {}", e))
}

/// Check if cache is fresh for a given folder
pub fn get_cache_status(
    bucket: &str,
    prefix: &str,
) -> Result<CacheStatus, String> {
    let now = current_timestamp();
    let conn = get_db()?;

    let mut stmt = conn.prepare(
        "SELECT last_sync, item_count FROM folder_sync WHERE bucket = ? AND prefix = ?"
    ).map_err(|e| e.to_string())?;

    let result: Result<(i64, Option<i64>), _> = stmt.query_row(params![bucket, prefix], |row| {
        Ok((row.get(0)?, row.get(1)?))
    });

    match result {
        Ok((last_sync, item_count)) => {
            let age = now - last_sync;
            Ok(CacheStatus {
                is_fresh: age < CACHE_TTL_SECONDS,
                last_sync: Some(last_sync),
                item_count: item_count.unwrap_or(0),
            })
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(CacheStatus {
            is_fresh: false,
            last_sync: None,
            item_count: 0,
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Get cached files for a folder (direct children only)
pub fn get_cached_files(
    bucket: &str,
    prefix: &str,
) -> Result<Vec<CachedFileObject>, String> {
    let conn = get_db()?;

    // Build pattern for direct children only
    // Use %/_% to require at least one char after the nested slash
    // This excludes "Documents/subfolder/file.txt" but keeps "Documents/folder/"
    let pattern = format!("{}%", prefix);
    let exclude_pattern = format!("{}%/_%", prefix);

    let mut stmt = conn.prepare(
        r#"
        SELECT key, size, last_modified, is_dir
        FROM file_cache
        WHERE bucket = ?
          AND key LIKE ?
          AND key NOT LIKE ?
          AND key != ?
        ORDER BY is_dir DESC, key ASC
        "#
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![bucket, &pattern, &exclude_pattern, prefix], |row| {
        Ok(CachedFileObject {
            key: row.get(0)?,
            size: row.get(1)?,
            last_modified: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            is_dir: row.get::<_, i64>(3)? != 0,
        })
    }).map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Store files in cache (replaces existing entries for this folder)
pub fn upsert_files_to_cache(
    bucket: &str,
    prefix: &str,
    files: &[CachedFileObject],
) -> Result<(), String> {
    let conn = get_db()?;
    let now = current_timestamp();

    // Delete existing entries for this prefix (direct children only)
    let pattern = format!("{}%", prefix);
    let exclude_pattern = format!("{}%/_%", prefix);

    conn.execute(
        "DELETE FROM file_cache WHERE bucket = ? AND key LIKE ? AND key NOT LIKE ? AND key != ?",
        params![bucket, &pattern, &exclude_pattern, prefix]
    ).map_err(|e| e.to_string())?;

    // Insert new entries
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO file_cache (bucket, key, size, last_modified, is_dir, cached_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).map_err(|e| e.to_string())?;

    for file in files {
        stmt.execute(params![
            bucket,
            &file.key,
            file.size,
            &file.last_modified,
            if file.is_dir { 1i64 } else { 0i64 },
            now
        ]).map_err(|e| e.to_string())?;
    }

    // Update folder sync status
    conn.execute(
        "INSERT OR REPLACE INTO folder_sync (bucket, prefix, last_sync, item_count) VALUES (?, ?, ?, ?)",
        params![bucket, prefix, now, files.len() as i64]
    ).map_err(|e| e.to_string())?;

    Ok(())
}

/// Invalidate cache for a specific folder
pub fn invalidate_folder_cache(
    bucket: &str,
    prefix: &str,
) -> Result<(), String> {
    let conn = get_db()?;

    conn.execute(
        "DELETE FROM folder_sync WHERE bucket = ? AND prefix = ?",
        params![bucket, prefix]
    ).map_err(|e| e.to_string())?;

    Ok(())
}

/// Get the parent prefix of a key
pub fn get_parent_prefix(key: &str) -> String {
    let trimmed = key.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(pos) => format!("{}/", &trimmed[..pos]),
        None => String::new(), // Root level
    }
}

/// Cleanup old cache entries
pub fn cleanup_old_cache(max_age_seconds: i64) -> Result<u64, String> {
    let conn = get_db()?;
    let cutoff = current_timestamp() - max_age_seconds;

    let deleted = conn.execute(
        "DELETE FROM file_cache WHERE cached_at < ?",
        params![cutoff]
    ).map_err(|e| e.to_string())? as u64;

    conn.execute(
        "DELETE FROM folder_sync WHERE last_sync < ?",
        params![cutoff]
    ).map_err(|e| e.to_string())?;

    Ok(deleted)
}
