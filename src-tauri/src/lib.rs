mod remote_ssh;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_FILE_BYTES: u64 = 1_000_000;
const MAX_INDEXED_FILES: usize = 20_000;
const MAX_SCAN_DEPTH: usize = 18;

const SKIPPED_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "target",
    "coverage",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "vendor",
    "__pycache__",
];

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "astro",
    "c",
    "cc",
    "cpp",
    "cs",
    "css",
    "csv",
    "cts",
    "cjs",
    "go",
    "gql",
    "graphql",
    "h",
    "hpp",
    "html",
    "java",
    "js",
    "jsx",
    "json",
    "kt",
    "less",
    "log",
    "lua",
    "md",
    "mdx",
    "mjs",
    "mts",
    "php",
    "prisma",
    "py",
    "rb",
    "rs",
    "sass",
    "scss",
    "sql",
    "svelte",
    "swift",
    "toml",
    "ts",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
];

const SUPPORTED_SPECIAL_FILES: &[&str] = &[
    ".env",
    ".env.example",
    ".env.local",
    ".gitignore",
    ".npmrc",
    ".prettierrc",
    ".eslintrc",
    "Dockerfile",
    "Makefile",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeFileEntry {
    path: String,
    relative_path: String,
    name: String,
    extension: String,
    size: u64,
}

#[tauri::command]
fn scan_directory(root_path: String) -> Result<Vec<CodeFileEntry>, String> {
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|error| format!("Could not open directory: {error}"))?;

    if !root.is_dir() {
        return Err("Selected path is not a directory.".to_string());
    }

    let mut files = Vec::new();
    walk_directory(&root, &root, 0, &mut files)?;

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    Ok(files)
}

#[tauri::command]
fn read_code_file(root_path: String, file_path: String) -> Result<String, String> {
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project directory: {error}"))?;

    let file = PathBuf::from(file_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve file path: {error}"))?;

    if !file.starts_with(&root) {
        return Err("Blocked file read outside the selected directory.".to_string());
    }

    if !file.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    if !is_supported_code_file(&file) {
        return Err("This file type is not supported in PromptPAD yet.".to_string());
    }

    let metadata = fs::metadata(&file).map_err(|error| format!("Could not read file metadata: {error}"))?;

    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "File is too large for the MVP limit: {} bytes.",
            metadata.len()
        ));
    }

    fs::read_to_string(&file).map_err(|error| {
        format!(
            "Could not read file as UTF-8 text. This may be a binary or encoded file: {error}"
        )
    })
}

fn walk_directory(
    root: &Path,
    current: &Path,
    depth: usize,
    files: &mut Vec<CodeFileEntry>,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH || files.len() >= MAX_INDEXED_FILES {
        return Ok(());
    }

    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry_result in entries {
        if files.len() >= MAX_INDEXED_FILES {
            break;
        }

        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            if should_skip_directory(&name) {
                continue;
            }

            walk_directory(root, &path, depth + 1, files)?;
            continue;
        }

        if !file_type.is_file() || !is_supported_code_file(&path) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }

        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        files.push(CodeFileEntry {
            path: path.to_string_lossy().to_string(),
            relative_path,
            name,
            extension: extension_label(&path),
            size: metadata.len(),
        });
    }

    Ok(())
}

fn should_skip_directory(name: &str) -> bool {
    SKIPPED_DIRECTORIES.iter().any(|skipped| skipped == &name)
}

fn is_supported_code_file(path: &Path) -> bool {
    let file_name = match path.file_name().and_then(|name| name.to_str()) {
        Some(file_name) => file_name,
        None => return false,
    };

    if SUPPORTED_SPECIAL_FILES
        .iter()
        .any(|supported| supported.eq_ignore_ascii_case(file_name))
    {
        return true;
    }

    if file_name.starts_with(".env.") {
        return true;
    }

    let extension = match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) => extension.to_ascii_lowercase(),
        None => return false,
    };

    SUPPORTED_EXTENSIONS
        .iter()
        .any(|supported| supported == &extension.as_str())
}

fn extension_label(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("txt")
        .to_ascii_lowercase()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            read_code_file,
            remote_ssh::ssh_list_directory,
            remote_ssh::ssh_read_file,
            remote_ssh::ssh_read_directory_files,
            remote_ssh::ssh_download_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running PromptPAD");
}