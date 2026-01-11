// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod s3_client;
mod commands;
mod cache;

use tokio::sync::Mutex;
use std::sync::atomic::AtomicBool;
use tauri::menu::{Menu, Submenu, PredefinedMenuItem};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Initialize the SQLite cache database
            if let Err(e) = cache::init_database(app.handle()) {
                eprintln!("Failed to initialize cache database: {}", e);
            }
            // Create a simplified menu
            let about = PredefinedMenuItem::about(app, Some("About Mosaic Drive"), None)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let hide = PredefinedMenuItem::hide(app, Some("Hide Mosaic Drive"))?;
            let quit = PredefinedMenuItem::quit(app, Some("Quit Mosaic Drive"))?;

            let app_menu = Submenu::with_items(
                app,
                "Mosaic Drive",
                true,
                &[&about, &separator, &hide, &separator, &quit],
            )?;

            let menu = Menu::with_items(app, &[&app_menu])?;
            app.set_menu(menu)?;

            Ok(())
        })
        .manage(commands::AppState {
            client: Mutex::new(None),
            cancel_upload: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::list_buckets,
            commands::list_objects,
            commands::list_objects_cached,
            commands::invalidate_cache,
            commands::refresh_folder,
            commands::upload_file,
            commands::cancel_current_upload,
            commands::create_s3_folder,
            commands::delete_object,
            commands::move_to_trash,
            commands::empty_trash,
            commands::download_file,
            commands::download_folder,
            commands::download_files_as_zip,
            commands::download_files_to_folder,
            commands::move_files,
            commands::rename_object,
            commands::get_storage_stats,
            commands::get_presigned_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
