use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use crate::s3_client::S3Client;
use crate::cache::{self, CachedFileObject, ListResult, CacheStatus};
use keyring::Entry;
use serde::Serialize;
use aws_sdk_s3::presigning::PresigningConfig;

pub struct AppState {
    pub client: Mutex<Option<S3Client>>,
    pub cancel_upload: AtomicBool,
}

#[derive(Clone, Serialize)]
pub struct UploadProgress {
    pub filename: String,
    pub current_file: usize,
    pub total_files: usize,
    pub bytes_uploaded: u64,
    pub total_bytes: u64,
    pub percent: u8,
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub filename: String,
    pub current_file: usize,
    pub total_files: usize,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percent: u8,
}

#[tauri::command]
pub async fn connect(
    access_key: String,
    secret_key: String,
    endpoint: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let client = S3Client::new(access_key.clone(), secret_key.clone(), endpoint.clone(), None)
        .await
        .map_err(|e| e.to_string())?;

    // Verify credentials by attempting to access the user's bucket
    let verify_result = client.client.list_objects_v2()
        .bucket(&access_key)
        .max_keys(1)
        .send()
        .await;

    if let Err(e) = verify_result {
        let err_str = e.to_string();
        if err_str.contains("403") || err_str.contains("Forbidden") || 
           err_str.contains("InvalidAccessKeyId") || err_str.contains("SignatureDoesNotMatch") {
            return Err("Invalid Credentials".to_string());
        }
        return Err(format!("Connection Failed: {}", err_str));
    }

    *state.client.lock().await = Some(client);

    // Save to keyring
    let _ = Entry::new("mosaic-drive", &access_key)
        .and_then(|e| e.set_password(&secret_key));
    
    Ok(())
}

#[tauri::command]
pub async fn list_buckets(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;
    
    let resp = client.client.list_buckets().send().await.map_err(|e| {
        println!("Error listing buckets: {:?}", e);
        e.to_string()
    })?;
    let buckets = resp.buckets.unwrap_or_default();
    
    Ok(buckets.into_iter().filter_map(|b| b.name).collect())
}

#[tauri::command]
pub async fn list_objects(bucket: String, prefix: String, state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let start = std::time::Instant::now();
    let guard = state.client.lock().await;
    let lock_time = start.elapsed();

    let client = guard.as_ref().ok_or("Not connected")?;

    let mut files = Vec::new();
    let mut continuation_token = None;
    let mut page_count = 0;

    loop {
        let page_start = std::time::Instant::now();
        let resp = client.client.list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .delimiter("/")
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|e| {
                 println!("Error listing objects: {:?}", e);
                 e.to_string()
            })?;

        page_count += 1;
        println!("DEBUG list_objects: page {} took {:?}, prefix={}", page_count, page_start.elapsed(), prefix);

        // Add directories (CommonPrefixes)
        for common_prefix in resp.common_prefixes.unwrap_or_default() {
            if let Some(p) = common_prefix.prefix {
                 // Check if we already have this directory (could happen across pages?)
                 // Generally CommonPrefixes should be unique per page, but for safety in the aggregate list:
                 let entry = serde_json::json!({
                     "key": p,
                     "size": 0,
                     "last_modified": "",
                     "is_dir": true
                 });
                 // Deduplication check might be expensive O(N^2), but N isn't usually massive for dirs. 
                 // Actually, AWS returns sorted keys.
                 files.push(entry);
            }
        }
        
        // Add files (Contents)
        for object in resp.contents.unwrap_or_default() {
            if let Some(key) = &object.key {
                 if key.ends_with('/') && object.size.unwrap_or(0) == 0 {
                     continue;
                 }
            }

            files.push(serde_json::json!({
                "key": object.key,
                "size": object.size,
                "last_modified": object.last_modified.map(|t| t.to_string()).unwrap_or_default(),
                "is_dir": false
            }));
        }

        if resp.is_truncated.unwrap_or(false) {
            continuation_token = resp.next_continuation_token;
        } else {
            break;
        }
    }
    
    println!("DEBUG list_objects: TOTAL {:?}, lock={:?}, pages={}, items={}, prefix={}",
             start.elapsed(), lock_time, page_count, files.len(), prefix);

    Ok(files)
}

/// Cache-aware list objects command
/// Returns cached data immediately if available, refreshes in background if stale
#[tauri::command]
pub async fn list_objects_cached(
    bucket: String,
    prefix: String,
    force_refresh: bool,
    app: AppHandle,
    state: State<'_, AppState>
) -> Result<ListResult, String> {
    let start = std::time::Instant::now();

    // Check cache status (synchronous call)
    let cache_status = cache::get_cache_status(&bucket, &prefix)?;

    // If cache is fresh and not forcing refresh, return cached data immediately
    if cache_status.is_fresh && !force_refresh {
        let files = cache::get_cached_files(&bucket, &prefix)?;
        println!("DEBUG list_objects_cached: cache HIT, {} items, {:?}, prefix={}",
                 files.len(), start.elapsed(), prefix);
        return Ok(ListResult {
            files,
            from_cache: true,
            cache_status,
        });
    }

    // If cache exists but stale, return cached data AND trigger background refresh
    if cache_status.last_sync.is_some() && !force_refresh {
        let files = cache::get_cached_files(&bucket, &prefix)?;
        println!("DEBUG list_objects_cached: cache STALE, returning {} items + bg refresh, prefix={}",
                 files.len(), prefix);

        // Spawn background refresh
        let app_clone = app.clone();
        let bucket_clone = bucket.clone();
        let prefix_clone = prefix.clone();
        let state_client = {
            let guard = state.client.lock().await;
            guard.as_ref().ok_or("Not connected")?.client.clone()
        };

        tokio::spawn(async move {
            if let Err(e) = refresh_folder_in_background(&app_clone, state_client, &bucket_clone, &prefix_clone).await {
                println!("DEBUG: Background refresh failed: {}", e);
            }
        });

        return Ok(ListResult {
            files,
            from_cache: true,
            cache_status,
        });
    }

    // No cache exists or force refresh - fetch from S3 synchronously
    println!("DEBUG list_objects_cached: cache MISS, fetching from S3, prefix={}", prefix);
    let files = fetch_and_cache_folder(&state, &bucket, &prefix).await?;

    let new_status = CacheStatus {
        is_fresh: true,
        last_sync: Some(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64),
        item_count: files.len() as i64,
    };

    println!("DEBUG list_objects_cached: fetched {} items, {:?}, prefix={}",
             files.len(), start.elapsed(), prefix);

    Ok(ListResult {
        files,
        from_cache: false,
        cache_status: new_status,
    })
}

/// Fetch files from S3 and store in cache
async fn fetch_and_cache_folder(
    state: &State<'_, AppState>,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<CachedFileObject>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    let mut files = Vec::new();
    let mut continuation_token = None;

    loop {
        let resp = client.client.list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .delimiter("/")
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        // Add directories (CommonPrefixes)
        for common_prefix in resp.common_prefixes.unwrap_or_default() {
            if let Some(p) = common_prefix.prefix {
                files.push(CachedFileObject {
                    key: p,
                    size: 0,
                    last_modified: String::new(),
                    is_dir: true,
                });
            }
        }

        // Add files (Contents)
        for object in resp.contents.unwrap_or_default() {
            if let Some(key) = &object.key {
                // Skip directory markers
                if key.ends_with('/') && object.size.unwrap_or(0) == 0 {
                    continue;
                }
                // Skip the prefix itself
                if key == prefix {
                    continue;
                }
            }

            if let Some(key) = object.key {
                files.push(CachedFileObject {
                    key,
                    size: object.size.unwrap_or(0),
                    last_modified: object.last_modified.map(|t| t.to_string()).unwrap_or_default(),
                    is_dir: false,
                });
            }
        }

        if resp.is_truncated.unwrap_or(false) {
            continuation_token = resp.next_continuation_token;
        } else {
            break;
        }
    }

    // Store in cache (synchronous)
    cache::upsert_files_to_cache(bucket, prefix, &files)?;

    Ok(files)
}

/// Background refresh without blocking the UI
async fn refresh_folder_in_background(
    app: &AppHandle,
    client: aws_sdk_s3::Client,
    bucket: &str,
    prefix: &str,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let mut files = Vec::new();
    let mut continuation_token = None;

    loop {
        let resp = client.list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .delimiter("/")
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        for common_prefix in resp.common_prefixes.unwrap_or_default() {
            if let Some(p) = common_prefix.prefix {
                files.push(CachedFileObject {
                    key: p,
                    size: 0,
                    last_modified: String::new(),
                    is_dir: true,
                });
            }
        }

        for object in resp.contents.unwrap_or_default() {
            if let Some(key) = &object.key {
                if key.ends_with('/') && object.size.unwrap_or(0) == 0 {
                    continue;
                }
                if key == prefix {
                    continue;
                }
            }

            if let Some(key) = object.key {
                files.push(CachedFileObject {
                    key,
                    size: object.size.unwrap_or(0),
                    last_modified: object.last_modified.map(|t| t.to_string()).unwrap_or_default(),
                    is_dir: false,
                });
            }
        }

        if resp.is_truncated.unwrap_or(false) {
            continuation_token = resp.next_continuation_token;
        } else {
            break;
        }
    }

    // Store in cache (synchronous)
    cache::upsert_files_to_cache(bucket, prefix, &files)?;

    println!("DEBUG: Background refresh complete for {}, {} items, {:?}",
             prefix, files.len(), start.elapsed());

    // Emit event to notify frontend that cache was updated
    let _ = app.emit("cache-updated", serde_json::json!({
        "bucket": bucket,
        "prefix": prefix,
        "item_count": files.len()
    }));

    Ok(())
}

/// Invalidate cache for a folder (called after file operations)
#[tauri::command]
pub async fn invalidate_cache(
    bucket: String,
    prefix: String,
) -> Result<(), String> {
    cache::invalidate_folder_cache(&bucket, &prefix)
}

/// Force refresh a folder from S3
#[tauri::command]
pub async fn refresh_folder(
    bucket: String,
    prefix: String,
    state: State<'_, AppState>
) -> Result<Vec<CachedFileObject>, String> {
    fetch_and_cache_folder(&state, &bucket, &prefix).await
}

#[tauri::command]
pub async fn cancel_current_upload(state: State<'_, AppState>) -> Result<(), String> {
    println!("DEBUG: cancel_current_upload called");
    state.cancel_upload.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn upload_file(
    bucket: String,
    file_path: String,
    target_key: String,
    app: AppHandle,
    state: State<'_, AppState>
) -> Result<(), String> {
    println!("DEBUG: upload_file called for path: {}, target: {}", file_path, target_key);

    // Reset cancellation flag at start of upload
    state.cancel_upload.store(false, Ordering::SeqCst);

    // Clone the client and release the lock immediately to allow concurrent operations
    let client = {
        let guard = state.client.lock().await;
        guard.as_ref().ok_or("Not connected")?.client.clone()
    };

    // Helper function to check if object exists
    async fn object_exists(client: &aws_sdk_s3::Client, bucket: &str, key: &str) -> bool {
        client.head_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .is_ok()
    }

    // Helper function to get unique key (auto-increment if exists)
    async fn get_unique_key(client: &aws_sdk_s3::Client, bucket: &str, original_key: &str) -> String {
        if !object_exists(client, bucket, original_key).await {
            return original_key.to_string();
        }

        // Parse filename and extension
        let (base_path, name, ext) = if let Some(dot_pos) = original_key.rfind('.') {
            let before_dot = &original_key[..dot_pos];
            let ext = &original_key[dot_pos..]; // includes the dot
            if let Some(slash_pos) = before_dot.rfind('/') {
                (&original_key[..=slash_pos], &before_dot[slash_pos + 1..], ext)
            } else {
                ("", before_dot, ext)
            }
        } else {
            if let Some(slash_pos) = original_key.rfind('/') {
                (&original_key[..=slash_pos], &original_key[slash_pos + 1..], "")
            } else {
                ("", original_key, "")
            }
        };

        // Try incrementing numbers until we find a free name
        for i in 1..1000 {
            let new_key = format!("{}{} ({}){}", base_path, name, i, ext);
            if !object_exists(client, bucket, &new_key).await {
                println!("DEBUG: File exists, using unique name: {}", new_key);
                return new_key;
            }
        }

        // Fallback with timestamp if somehow 1000 copies exist
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{}{} ({}){}", base_path, name, timestamp, ext)
    }

    // Get unique target key (auto-increment if file exists)
    let target_key = get_unique_key(&client, &bucket, &target_key).await;
    println!("DEBUG: Final target key: {}", target_key);

    let path = std::path::Path::new(&file_path);

    if path.is_dir() {
        println!("DEBUG: Path is directory. Starting recursive walk.");
        use walkdir::WalkDir;

        // First pass: count files and total size
        let mut files_to_upload: Vec<(std::path::PathBuf, String, u64)> = Vec::new();
        let mut total_bytes: u64 = 0;

        for entry in WalkDir::new(path) {
            let entry = entry.map_err(|e| e.to_string())?;
            let entry_path = entry.path();
            let relative_path = entry_path.strip_prefix(path).map_err(|e| e.to_string())?;
            let relative_str = relative_path.to_string_lossy().replace('\\', "/");

            let s3_key = if relative_str.is_empty() {
                format!("{}/", target_key.trim_end_matches('/'))
            } else {
                format!("{}/{}", target_key.trim_end_matches('/'), relative_str)
            };

            if entry.file_type().is_file() {
                let metadata = entry.metadata().map_err(|e| e.to_string())?;
                let file_size = metadata.len();
                total_bytes += file_size;
                files_to_upload.push((entry_path.to_path_buf(), s3_key, file_size));
            } else if entry.file_type().is_dir() {
                // Create directory marker
                let dir_key = if s3_key.ends_with('/') { s3_key } else { format!("{}/", s3_key) };
                client.put_object()
                    .bucket(&bucket)
                    .key(dir_key)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        let total_files = files_to_upload.len();
        let mut bytes_uploaded: u64 = 0;

        // Second pass: upload files with progress
        for (idx, (entry_path, s3_key, file_size)) in files_to_upload.into_iter().enumerate() {
            let filename = entry_path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            // Emit progress before upload
            let percent = if total_bytes > 0 {
                ((bytes_uploaded as f64 / total_bytes as f64) * 100.0) as u8
            } else {
                0
            };

            let _ = app.emit("upload-progress", UploadProgress {
                filename: filename.clone(),
                current_file: idx + 1,
                total_files,
                bytes_uploaded,
                total_bytes,
                percent,
            });

            println!("DEBUG: Uploading file {}/{}: {} ({} bytes)", idx + 1, total_files, filename, file_size);
            let body = tokio::fs::read(&entry_path).await.map_err(|e| e.to_string())?;

            client.put_object()
                .bucket(&bucket)
                .key(&s3_key)
                .body(body.into())
                .send()
                .await
                .map_err(|e| e.to_string())?;

            bytes_uploaded += file_size;
        }

        // Emit 100% complete
        let _ = app.emit("upload-progress", UploadProgress {
            filename: "Complete".to_string(),
            current_file: total_files,
            total_files,
            bytes_uploaded: total_bytes,
            total_bytes,
            percent: 100,
        });

    } else {
        println!("DEBUG: Path is file. Uploading simple file.");
        let metadata = tokio::fs::metadata(&file_path).await.map_err(|e| e.to_string())?;
        let total_bytes = metadata.len();
        let filename = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        // Use multipart upload for files > 50MB
        const MULTIPART_THRESHOLD: u64 = 50 * 1024 * 1024; // 50MB
        const CHUNK_SIZE: u64 = 10 * 1024 * 1024; // 10MB chunks

        if total_bytes > MULTIPART_THRESHOLD {
            println!("DEBUG: Large file detected ({}MB), using multipart upload", total_bytes / 1024 / 1024);

            // Emit starting progress
            let _ = app.emit("upload-progress", UploadProgress {
                filename: filename.clone(),
                current_file: 1,
                total_files: 1,
                bytes_uploaded: 0,
                total_bytes,
                percent: 0,
            });

            // Create multipart upload
            let create_resp = client.create_multipart_upload()
                .bucket(&bucket)
                .key(&target_key)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let upload_id = create_resp.upload_id()
                .ok_or("No upload ID returned")?
                .to_string();

            let mut file = tokio::fs::File::open(&file_path).await.map_err(|e| e.to_string())?;
            let mut part_number = 1;
            let mut bytes_uploaded: u64 = 0;
            let mut completed_parts: Vec<aws_sdk_s3::types::CompletedPart> = Vec::new();

            use tokio::io::AsyncReadExt;

            loop {
                // Check for cancellation before each chunk
                if state.cancel_upload.load(Ordering::SeqCst) {
                    println!("DEBUG: Upload cancelled by user, aborting multipart upload");
                    let _ = client.abort_multipart_upload()
                        .bucket(&bucket)
                        .key(&target_key)
                        .upload_id(&upload_id)
                        .send()
                        .await;
                    return Err("Upload cancelled".to_string());
                }

                // Read a full chunk (loop until we have CHUNK_SIZE or EOF)
                let mut chunk = Vec::with_capacity(CHUNK_SIZE as usize);
                let mut temp_buf = vec![0u8; 64 * 1024]; // 64KB read buffer

                while chunk.len() < CHUNK_SIZE as usize {
                    let bytes_read = file.read(&mut temp_buf).await.map_err(|e| e.to_string())?;
                    if bytes_read == 0 {
                        break; // EOF
                    }
                    chunk.extend_from_slice(&temp_buf[..bytes_read]);
                }

                if chunk.is_empty() {
                    break; // No more data
                }

                // Truncate if we somehow read more than needed
                if chunk.len() > CHUNK_SIZE as usize {
                    chunk.truncate(CHUNK_SIZE as usize);
                }

                // Retry logic for individual parts (up to 3 attempts)
                let mut part_resp = None;
                let mut last_error = String::new();
                for attempt in 1..=3 {
                    let chunk_clone = chunk.clone();
                    let result = client.upload_part()
                        .bucket(&bucket)
                        .key(&target_key)
                        .upload_id(&upload_id)
                        .part_number(part_number)
                        .body(chunk_clone.into())
                        .send()
                        .await;

                    match result {
                        Ok(resp) => {
                            part_resp = Some(resp);
                            break;
                        }
                        Err(e) => {
                            last_error = e.to_string();
                            println!("ERROR: Part {} upload failed (attempt {}/3): {}", part_number, attempt, last_error);
                            if attempt < 3 {
                                // Wait before retry: 2s, 4s
                                let delay = std::time::Duration::from_secs(2 * attempt as u64);
                                println!("DEBUG: Retrying part {} in {:?}...", part_number, delay);
                                tokio::time::sleep(delay).await;
                            }
                        }
                    }
                }

                let part_resp = match part_resp {
                    Some(resp) => resp,
                    None => {
                        // All retries failed - abort multipart upload
                        println!("ERROR: Part {} failed after 3 attempts, aborting upload", part_number);
                        let _ = client.abort_multipart_upload()
                            .bucket(&bucket)
                            .key(&target_key)
                            .upload_id(&upload_id)
                            .send()
                            .await;
                        return Err(format!("Part {} failed after 3 retries: {}", part_number, last_error));
                    }
                };

                let etag = part_resp.e_tag().unwrap_or_default().to_string();
                completed_parts.push(
                    aws_sdk_s3::types::CompletedPart::builder()
                        .part_number(part_number)
                        .e_tag(etag)
                        .build()
                );

                let chunk_size = chunk.len();
                bytes_uploaded += chunk_size as u64;
                // Reserve 5% for the completion phase (0-95% for upload, 95-100% for completion)
                let percent = ((bytes_uploaded as f64 / total_bytes as f64) * 95.0) as u8;

                let _ = app.emit("upload-progress", UploadProgress {
                    filename: filename.clone(),
                    current_file: 1,
                    total_files: 1,
                    bytes_uploaded,
                    total_bytes,
                    percent,
                });

                println!("DEBUG: Uploaded part {} ({} bytes, {}%)", part_number, chunk_size, percent);
                part_number += 1;
            }

            // Emit 95% - completing multipart upload
            let _ = app.emit("upload-progress", UploadProgress {
                filename: filename.clone(),
                current_file: 1,
                total_files: 1,
                bytes_uploaded: total_bytes,
                total_bytes,
                percent: 95,
            });

            println!("DEBUG: Completing multipart upload for {}", target_key);
            println!("DEBUG: Upload ID: {}", upload_id);
            println!("DEBUG: Total parts to complete: {}", completed_parts.len());
            for (i, part) in completed_parts.iter().enumerate() {
                println!("DEBUG: Part {}: number={:?}, etag={:?}", i+1, part.part_number(), part.e_tag());
            }

            // Complete multipart upload with retry logic
            let completed_upload = aws_sdk_s3::types::CompletedMultipartUpload::builder()
                .set_parts(Some(completed_parts))
                .build();

            let mut complete_success = false;
            let mut last_complete_error = String::new();
            for attempt in 1..=3 {
                let upload_clone = completed_upload.clone();
                let result = client.complete_multipart_upload()
                    .bucket(&bucket)
                    .key(&target_key)
                    .upload_id(&upload_id)
                    .multipart_upload(upload_clone)
                    .send()
                    .await;

                match result {
                    Ok(_) => {
                        complete_success = true;
                        break;
                    }
                    Err(e) => {
                        // Extract detailed error info
                        let err_str = format!("{:?}", e); // Debug format for full details
                        last_complete_error = e.to_string();
                        println!("ERROR: Failed to complete multipart upload (attempt {}/3)", attempt);
                        println!("ERROR: Short: {}", last_complete_error);
                        println!("ERROR: Full: {}", err_str);

                        // Try to get service error details
                        if let Some(service_err) = e.as_service_error() {
                            println!("ERROR: Service error code: {:?}", service_err);
                        }

                        if attempt < 3 {
                            let delay = std::time::Duration::from_secs(2 * attempt as u64);
                            println!("DEBUG: Retrying completion in {:?}...", delay);
                            tokio::time::sleep(delay).await;
                        }
                    }
                }
            }

            if !complete_success {
                println!("ERROR: Failed to complete multipart upload after 3 attempts");
                // Don't abort - parts are uploaded, user might want to retry completion
                return Err(format!("Failed to complete upload after 3 retries: {}", last_complete_error));
            }

            println!("DEBUG: Successfully completed multipart upload for {}", target_key);

            // Emit 100% complete - only after successful completion
            let _ = app.emit("upload-progress", UploadProgress {
                filename: filename.clone(),
                current_file: 1,
                total_files: 1,
                bytes_uploaded: total_bytes,
                total_bytes,
                percent: 100,
            });

        } else {
            // Regular upload for smaller files
            let _ = app.emit("upload-progress", UploadProgress {
                filename: filename.clone(),
                current_file: 1,
                total_files: 1,
                bytes_uploaded: 0,
                total_bytes,
                percent: 0,
            });

            let body = tokio::fs::read(&file_path).await.map_err(|e| e.to_string())?;

            client.put_object()
                .bucket(&bucket)
                .key(&target_key)
                .body(body.into())
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let _ = app.emit("upload-progress", UploadProgress {
                filename: filename.clone(),
                current_file: 1,
                total_files: 1,
                bytes_uploaded: total_bytes,
                total_bytes,
                percent: 100,
            });
        }
    }

    Ok(())
}


#[tauri::command]
pub async fn create_s3_folder(
    bucket: String,
    path: String,
    state: State<'_, AppState>
) -> Result<(), String> {
    println!("DEBUG: create_s3_folder called for bucket: {}, path: {}", bucket, path);
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    let folder_key = if path.ends_with('/') { path.clone() } else { format!("{}/", path) };

    client.client.put_object()
        .bucket(bucket)
        .key(&folder_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    println!("DEBUG: Created folder object: {}", folder_key);
    Ok(())
}

#[tauri::command]
pub async fn delete_object(
    bucket: String,
    key: String,
    state: State<'_, AppState>
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    client.client.delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn move_to_trash(
    bucket: String,
    key: String,
    state: State<'_, AppState>
) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    // Get just the filename from the key
    let filename = key.split('/').last().ok_or("Invalid key")?;

    // Create trash key with timestamp to avoid collisions
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let trash_key = format!(".Trash/{}_{}", timestamp, filename);

    // Copy object to trash
    let copy_source = format!("{}/{}", bucket, key);
    client.client.copy_object()
        .bucket(&bucket)
        .key(&trash_key)
        .copy_source(&copy_source)
        .send()
        .await
        .map_err(|e| format!("Failed to copy to trash: {}", e))?;

    // Delete original
    client.client.delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("Failed to delete original: {}", e))?;

    println!("DEBUG: Moved {} to trash as {}", key, trash_key);
    Ok(())
}

#[tauri::command]
pub async fn empty_trash(
    bucket: String,
    state: State<'_, AppState>
) -> Result<u32, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    let mut deleted_count: u32 = 0;
    let mut continuation_token = None;

    loop {
        let resp = client.client.list_objects_v2()
            .bucket(&bucket)
            .prefix(".Trash/")
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        for object in resp.contents.unwrap_or_default() {
            if let Some(key) = object.key {
                client.client.delete_object()
                    .bucket(&bucket)
                    .key(&key)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                deleted_count += 1;
            }
        }

        if resp.is_truncated.unwrap_or(false) {
            continuation_token = resp.next_continuation_token;
        } else {
            break;
        }
    }

    println!("DEBUG: Emptied trash, deleted {} items", deleted_count);
    Ok(deleted_count)
}



#[tauri::command]
pub async fn download_file(
    bucket: String,
    key: String,
    save_path: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>
) -> Result<String, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    let file_name = key.split('/').last().ok_or("Invalid key")?;

    // Use provided save_path or default to Downloads with auto-increment
    let final_path = if let Some(path) = save_path {
        std::path::PathBuf::from(path)
    } else {
        let download_dir = app.path().download_dir().map_err(|e| e.to_string())?;

        // Find unique filename if file already exists
        let base_path = download_dir.join(file_name);
        if !base_path.exists() {
            base_path
        } else {
            let stem = std::path::Path::new(file_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(file_name);
            let extension = std::path::Path::new(file_name)
                .extension()
                .and_then(|s| s.to_str());

            let mut counter = 1;
            loop {
                let new_name = match extension {
                    Some(ext) => format!("{} ({}).{}", stem, counter, ext),
                    None => format!("{} ({})", stem, counter),
                };
                let new_path = download_dir.join(&new_name);
                if !new_path.exists() {
                    break new_path;
                }
                counter += 1;
            }
        }
    };

    let resp = client.client.get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let data = resp.body.collect().await.map_err(|e| e.to_string())?.into_bytes();

    tokio::fs::write(&final_path, data).await.map_err(|e| e.to_string())?;

    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn download_folder(
    bucket: String,
    prefix: String,
    save_path: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>
) -> Result<String, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    // Get folder name for zip file
    let folder_name = prefix.trim_end_matches('/').split('/').last().ok_or("Invalid prefix")?;

    // Use provided save_path or default to Downloads with auto-increment
    let zip_path = if let Some(path) = save_path {
        std::path::PathBuf::from(path)
    } else {
        let download_dir = app.path().download_dir().map_err(|e| e.to_string())?;

        // Find unique zip filename if file already exists
        let base_name = format!("{}.zip", folder_name);
        let base_path = download_dir.join(&base_name);
        if !base_path.exists() {
            base_path
        } else {
            let mut counter = 1;
            loop {
                let new_name = format!("{} ({}).zip", folder_name, counter);
                let new_path = download_dir.join(&new_name);
                if !new_path.exists() {
                    break new_path;
                }
                counter += 1;
            }
        }
    };

    // List all objects in the folder
    let mut all_objects = Vec::new();
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client.client.list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix);

        if let Some(token) = continuation_token {
            req = req.continuation_token(token);
        }

        let resp = req.send().await.map_err(|e| e.to_string())?;

        for obj in resp.contents.unwrap_or_default() {
            if let Some(key) = &obj.key {
                // Skip if it's just the folder itself or a .keep file
                if key != &prefix && !key.ends_with(".keep") && !key.ends_with(".gitkeep") {
                    all_objects.push(key.to_string());
                }
            }
        }

        if resp.is_truncated == Some(true) {
            continuation_token = resp.next_continuation_token;
        } else {
            break;
        }
    }

    if all_objects.is_empty() {
        return Err("Folder is empty".to_string());
    }

    // Create zip file
    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for key in &all_objects {
        // Get relative path within the folder
        let relative_path = key.strip_prefix(&prefix).unwrap_or(key);
        if relative_path.is_empty() {
            continue;
        }

        // Download the file
        let resp = client.client.get_object()
            .bucket(&bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to download {}: {}", key, e))?;

        let data = resp.body.collect().await.map_err(|e| e.to_string())?.into_bytes();

        // Add to zip
        zip.start_file(relative_path, options).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }

    zip.finish().map_err(|e| e.to_string())?;

    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn download_files_as_zip(
    bucket: String,
    keys: Vec<String>,
    save_path: String,
    app: AppHandle,
    state: State<'_, AppState>
) -> Result<String, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    if keys.is_empty() {
        return Err("No files selected".to_string());
    }

    let zip_path = std::path::PathBuf::from(&save_path);
    let total_files = keys.len();

    // First pass: get total size of all files
    let mut file_sizes: Vec<(String, String, u64)> = Vec::new(); // (key, filename, size)
    let mut total_bytes: u64 = 0;

    for key in &keys {
        let file_name = key.split('/').last().unwrap_or(key).to_string();
        if file_name.is_empty() {
            continue;
        }

        // Get file size using head_object
        let head_resp = client.client.head_object()
            .bucket(&bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to get info for {}: {}", key, e))?;

        let size = head_resp.content_length().unwrap_or(0) as u64;
        total_bytes += size;
        file_sizes.push((key.clone(), file_name, size));
    }

    // Emit initial progress
    let _ = app.emit("download-progress", DownloadProgress {
        filename: "Starting...".to_string(),
        current_file: 0,
        total_files,
        bytes_downloaded: 0,
        total_bytes,
        percent: 0,
    });

    // Create zip file
    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut bytes_downloaded: u64 = 0;

    for (idx, (key, file_name, file_size)) in file_sizes.iter().enumerate() {
        // Emit progress before download
        let percent = if total_bytes > 0 {
            ((bytes_downloaded as f64 / total_bytes as f64) * 100.0) as u8
        } else {
            0
        };

        let _ = app.emit("download-progress", DownloadProgress {
            filename: file_name.clone(),
            current_file: idx + 1,
            total_files,
            bytes_downloaded,
            total_bytes,
            percent,
        });

        // Download the file
        let resp = client.client.get_object()
            .bucket(&bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to download {}: {}", key, e))?;

        let data = resp.body.collect().await.map_err(|e| e.to_string())?.into_bytes();

        // Add to zip (use filename only, not full path)
        zip.start_file(file_name.as_str(), options).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;

        bytes_downloaded += *file_size;
    }

    zip.finish().map_err(|e| e.to_string())?;

    // Emit 100% complete
    let _ = app.emit("download-progress", DownloadProgress {
        filename: "Complete".to_string(),
        current_file: total_files,
        total_files,
        bytes_downloaded: total_bytes,
        total_bytes,
        percent: 100,
    });

    Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn download_files_to_folder(
    bucket: String,
    keys: Vec<String>,
    folder_path: String,
    app: AppHandle,
    state: State<'_, AppState>
) -> Result<String, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    if keys.is_empty() {
        return Err("No files selected".to_string());
    }

    let folder = std::path::PathBuf::from(&folder_path);
    if !folder.exists() {
        return Err("Destination folder does not exist".to_string());
    }

    let total_files = keys.len();

    // First pass: get total size of all files
    let mut file_info: Vec<(String, String, u64)> = Vec::new(); // (key, filename, size)
    let mut total_bytes: u64 = 0;

    for key in &keys {
        let file_name = key.split('/').last().unwrap_or(key).to_string();
        if file_name.is_empty() {
            continue;
        }

        // Get file size using head_object
        let head_resp = client.client.head_object()
            .bucket(&bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to get info for {}: {}", key, e))?;

        let size = head_resp.content_length().unwrap_or(0) as u64;
        total_bytes += size;
        file_info.push((key.clone(), file_name, size));
    }

    // Emit initial progress
    let _ = app.emit("download-progress", DownloadProgress {
        filename: "Starting...".to_string(),
        current_file: 0,
        total_files,
        bytes_downloaded: 0,
        total_bytes,
        percent: 0,
    });

    let mut bytes_downloaded: u64 = 0;
    let mut downloaded_count = 0;

    // Helper function to get unique filename
    fn get_unique_path(folder: &std::path::Path, filename: &str) -> std::path::PathBuf {
        let base_path = folder.join(filename);
        if !base_path.exists() {
            return base_path;
        }

        let stem = std::path::Path::new(filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(filename);
        let extension = std::path::Path::new(filename)
            .extension()
            .and_then(|s| s.to_str());

        let mut counter = 1;
        loop {
            let new_name = match extension {
                Some(ext) => format!("{} ({}).{}", stem, counter, ext),
                None => format!("{} ({})", stem, counter),
            };
            let new_path = folder.join(&new_name);
            if !new_path.exists() {
                return new_path;
            }
            counter += 1;
            if counter > 1000 {
                // Fallback with timestamp
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                let fallback_name = match extension {
                    Some(ext) => format!("{} ({}).{}", stem, timestamp, ext),
                    None => format!("{} ({})", stem, timestamp),
                };
                return folder.join(fallback_name);
            }
        }
    }

    for (idx, (key, file_name, file_size)) in file_info.iter().enumerate() {
        // Emit progress before download
        let percent = if total_bytes > 0 {
            ((bytes_downloaded as f64 / total_bytes as f64) * 100.0) as u8
        } else {
            0
        };

        let _ = app.emit("download-progress", DownloadProgress {
            filename: file_name.clone(),
            current_file: idx + 1,
            total_files,
            bytes_downloaded,
            total_bytes,
            percent,
        });

        // Download the file
        let resp = client.client.get_object()
            .bucket(&bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to download {}: {}", key, e))?;

        let data = resp.body.collect().await.map_err(|e| e.to_string())?.into_bytes();

        // Get unique path (auto-increment if exists)
        let save_path = get_unique_path(&folder, file_name);

        // Write to file
        tokio::fs::write(&save_path, data).await.map_err(|e| e.to_string())?;

        bytes_downloaded += *file_size;
        downloaded_count += 1;
    }

    // Emit 100% complete
    let _ = app.emit("download-progress", DownloadProgress {
        filename: "Complete".to_string(),
        current_file: total_files,
        total_files,
        bytes_downloaded: total_bytes,
        total_bytes,
        percent: 100,
    });

    Ok(format!("Downloaded {} files to {}", downloaded_count, folder_path))
}

#[tauri::command]
pub async fn move_files(
    bucket: String,
    keys: Vec<String>,
    target_folder: String,
    state: State<'_, AppState>
) -> Result<u32, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    if keys.is_empty() {
        return Err("No files selected".to_string());
    }

    let mut moved_count: u32 = 0;

    for key in &keys {
        // Get filename from key
        let file_name = key.split('/').last().unwrap_or(key);
        if file_name.is_empty() {
            continue;
        }

        // Build target key
        let target_key = if target_folder.is_empty() {
            file_name.to_string()
        } else if target_folder.ends_with('/') {
            format!("{}{}", target_folder, file_name)
        } else {
            format!("{}/{}", target_folder, file_name)
        };

        // Skip if source and target are the same
        if key == &target_key {
            continue;
        }

        // Copy to new location (URL-encode the key for copy source)
        let encoded_key = urlencoding::encode(key);
        let copy_source = format!("/{}/{}", bucket, encoded_key);
        client.client.copy_object()
            .bucket(&bucket)
            .key(&target_key)
            .copy_source(&copy_source)
            .send()
            .await
            .map_err(|e| format!("Failed to copy {}: {}", key, e))?;

        // Delete original
        client.client.delete_object()
            .bucket(&bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| format!("Failed to delete original {}: {}", key, e))?;

        moved_count += 1;
        println!("DEBUG: Moved {} to {}", key, target_key);
    }

    Ok(moved_count)
}

#[tauri::command]
pub async fn rename_object(
    bucket: String,
    old_key: String,
    new_name: String,
    state: State<'_, AppState>
) -> Result<String, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    // Validate new name
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if new_name.contains('/') {
        return Err("Name cannot contain /".to_string());
    }

    // Build new key by replacing the filename part
    let is_folder = old_key.ends_with('/');
    let path_parts: Vec<&str> = old_key.trim_end_matches('/').split('/').collect();

    let new_key = if path_parts.len() > 1 {
        // Has parent path
        let parent = path_parts[..path_parts.len()-1].join("/");
        if is_folder {
            format!("{}/{}/", parent, new_name)
        } else {
            format!("{}/{}", parent, new_name)
        }
    } else {
        // Root level
        if is_folder {
            format!("{}/", new_name)
        } else {
            new_name.to_string()
        }
    };

    // Skip if name didn't change
    if old_key == new_key {
        return Ok(new_key);
    }

    if is_folder {
        // For folders, we need to rename all objects with this prefix
        let mut continuation_token = None;
        let mut keys_to_rename: Vec<String> = Vec::new();

        // List all objects under this folder
        loop {
            let resp = client.client.list_objects_v2()
                .bucket(&bucket)
                .prefix(&old_key)
                .set_continuation_token(continuation_token)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            if let Some(contents) = resp.contents {
                for obj in contents {
                    if let Some(key) = obj.key {
                        keys_to_rename.push(key);
                    }
                }
            }

            if resp.is_truncated.unwrap_or(false) {
                continuation_token = resp.next_continuation_token;
            } else {
                break;
            }
        }

        // Rename each object
        for key in keys_to_rename {
            let new_obj_key = key.replacen(&old_key, &new_key, 1);
            // URL-encode the key for the copy source (S3 requirement)
            let encoded_key = urlencoding::encode(&key);
            let copy_source = format!("{}/{}", bucket, encoded_key);

            client.client.copy_object()
                .bucket(&bucket)
                .key(&new_obj_key)
                .copy_source(&copy_source)
                .send()
                .await
                .map_err(|e| format!("Failed to copy {}: {}", key, e))?;

            client.client.delete_object()
                .bucket(&bucket)
                .key(&key)
                .send()
                .await
                .map_err(|e| format!("Failed to delete {}: {}", key, e))?;
        }
    } else {
        // Single file rename - use copy + delete
        // Format: /bucket/key (URL-encoded key)
        let encoded_key = urlencoding::encode(&old_key);
        let copy_source = format!("/{}/{}", bucket, encoded_key);

        println!("DEBUG rename: old_key={}, new_key={}, copy_source={}", old_key, new_key, copy_source);

        let copy_result = client.client.copy_object()
            .bucket(&bucket)
            .key(&new_key)
            .copy_source(&copy_source)
            .send()
            .await;

        if let Err(e) = &copy_result {
            println!("DEBUG rename copy error: {:?}", e);
            return Err(format!("Failed to copy: {}", e));
        }

        client.client.delete_object()
            .bucket(&bucket)
            .key(&old_key)
            .send()
            .await
            .map_err(|e| format!("Failed to delete original: {}", e))?;
    }

    println!("DEBUG: Renamed {} to {}", old_key, new_key);
    Ok(new_key)
}

#[derive(Clone, Serialize)]
pub struct StorageStats {
    pub used_bytes: u64,
    pub total_bytes: u64,  // 0 if unknown/unlimited
    pub object_count: u64,
}

#[tauri::command]
pub async fn get_storage_stats(
    bucket: String,
    state: State<'_, AppState>
) -> Result<StorageStats, String> {
    // Clone the S3 client so we can release the lock immediately
    // This prevents blocking other operations during the long iteration
    let s3_client = {
        let guard = state.client.lock().await;
        let client = guard.as_ref().ok_or("Not connected")?;
        client.client.clone()
    }; // Lock released here

    let mut total_size: u64 = 0;
    let mut object_count: u64 = 0;
    let mut continuation_token = None;

    println!("DEBUG: Starting storage stats calculation for bucket {}", bucket);
    let start = std::time::Instant::now();

    // Iterate through all objects to calculate total size
    loop {
        let resp = s3_client.list_objects_v2()
            .bucket(&bucket)
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if let Some(contents) = resp.contents {
            for obj in contents {
                if let Some(size) = obj.size {
                    total_size += size as u64;
                    object_count += 1;
                }
            }
        }

        if resp.is_truncated.unwrap_or(false) {
            continuation_token = resp.next_continuation_token;
        } else {
            break;
        }
    }

    println!("DEBUG: Storage stats complete: {} objects, {} bytes, took {:?}",
             object_count, total_size, start.elapsed());

    Ok(StorageStats {
        used_bytes: total_size,
        total_bytes: 0,
        object_count,
    })
}

#[tauri::command]
pub async fn get_presigned_url(
    bucket: String,
    key: String,
    expires_in_secs: Option<u64>,
    state: State<'_, AppState>
) -> Result<String, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not connected")?;

    let expires_in = Duration::from_secs(expires_in_secs.unwrap_or(3600)); // Default 1 hour
    let presigning_config = PresigningConfig::expires_in(expires_in)
        .map_err(|e| e.to_string())?;

    let presigned_request = client.client
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .presigned(presigning_config)
        .await
        .map_err(|e| e.to_string())?;

    Ok(presigned_request.uri().to_string())
}
