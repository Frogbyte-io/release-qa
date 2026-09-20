#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, io::ErrorKind, path::PathBuf};

use tauri::{AppHandle, Manager};

const SETTING_FILE: &str = "setting.txt";

fn setting_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(SETTING_FILE))
}

#[tauri::command]
fn load_value(app: AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(setting_path(&app)?) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_value(app: AppHandle, value: String) -> Result<(), String> {
    fs::write(setting_path(&app)?, value).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_value(app: AppHandle) -> Result<(), String> {
    match fs::remove_file(setting_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_value, save_value, clear_value])
        .run(tauri::generate_context!())
        .expect("error while running Release QA Smoke");
}
