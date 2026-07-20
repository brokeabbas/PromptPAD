use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
const SFTP_FILE_TYPE_MASK: u32 = 0o170000;
const SFTP_DIRECTORY_TYPE: u32 = 0o040000;
const SFTP_REGULAR_FILE_TYPE: u32 = 0o100000;

use ssh2::{Session, Sftp};
use std::{
    fs::File,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_REMOTE_FILE_BYTES: u64 = 1_000_000;
const MAX_REMOTE_DIRECTORY_FILES: usize = 2_000;
const MAX_REMOTE_SCAN_DEPTH: usize = 18;
const SSH_TIMEOUT_MS: u32 = 15_000;

const SKIPPED_REMOTE_DIRECTORIES: &[&str] = &[
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

const SUPPORTED_REMOTE_EXTENSIONS: &[&str] = &[
    "astro", "c", "cc", "cpp", "cs", "css", "csv", "cts", "cjs", "go", "gql",
    "graphql", "h", "hpp", "html", "java", "js", "jsx", "json", "kt", "less",
    "log", "lua", "md", "mdx", "mjs", "mts", "php", "prisma", "py", "rb", "rs",
    "sass", "scss", "sql", "svelte", "swift", "toml", "ts", "tsx", "txt", "vue",
    "xml", "yaml", "yml",
];

const SUPPORTED_REMOTE_SPECIAL_FILES: &[&str] = &[
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCredentials {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshListRequest {
    pub credentials: SshCredentials,
    pub remote_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshReadRequest {
    pub credentials: SshCredentials,
    pub remote_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshReadDirectoryRequest {
    pub credentials: SshCredentials,
    pub remote_path: String,
    pub operation_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirectoryProgress {
    pub operation_id: String,
    pub phase: String,
    pub completed: usize,
    pub total: usize,
    pub percent: u8,
    pub current_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDownloadRequest {
    pub credentials: SshCredentials,
    pub remote_path: String,
    pub local_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
}

fn emit_remote_directory_progress(
    app: &AppHandle,
    operation_id: &str,
    phase: &str,
    completed: usize,
    total: usize,
    current_path: Option<String>,
) {
    let percent = if phase == "done" {
        100
    } else if total == 0 {
        0
    } else {
        (((completed as f64 / total as f64) * 100.0).round())
            .clamp(0.0, 100.0) as u8
    };

    let _ = app.emit(
        "ssh-read-directory-progress",
        RemoteDirectoryProgress {
            operation_id: operation_id.to_string(),
            phase: phase.to_string(),
            completed,
            total,
            percent,
            current_path,
        },
    );
}

fn collect_remote_directory_candidates(
    sftp: &Sftp,
    current: &Path,
    depth: usize,
    files: &mut Vec<(PathBuf, u64)>,
) -> Result<(), String> {
    if depth > MAX_REMOTE_SCAN_DEPTH || files.len() >= MAX_REMOTE_DIRECTORY_FILES {
        return Ok(());
    }

    let entries = match sftp.readdir(current) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for (path, stat) in entries {
        if files.len() >= MAX_REMOTE_DIRECTORY_FILES {
            break;
        }

        let name = file_name_from_path(&path);

        if is_sftp_directory(stat.perm) {
            if should_skip_remote_directory(&name) {
                continue;
            }

            collect_remote_directory_candidates(sftp, &path, depth + 1, files)?;
            continue;
        }

        if !is_sftp_regular_file(stat.perm) || !is_supported_remote_code_file(&path) {
            continue;
        }

        let size = stat.size.unwrap_or(0);

        if size > MAX_REMOTE_FILE_BYTES {
            continue;
        }

        files.push((path, size));
    }

    Ok(())
}

fn connect(credentials: &SshCredentials) -> Result<Session, String> {
    let host = credentials.host.trim();

    if host.is_empty() {
        return Err("SSH host is required.".to_string());
    }

    if credentials.username.trim().is_empty() {
        return Err("SSH username is required.".to_string());
    }

    let port = credentials.port.unwrap_or(22);
    let address = format!("{host}:{port}");

    let tcp = TcpStream::connect(address).map_err(|error| {
        format!("Could not connect to SSH server. Check host, port, and network. Details: {error}")
    })?;

    tcp.set_read_timeout(Some(Duration::from_millis(SSH_TIMEOUT_MS as u64)))
        .map_err(|error| format!("Could not set SSH read timeout: {error}"))?;

    tcp.set_write_timeout(Some(Duration::from_millis(SSH_TIMEOUT_MS as u64)))
        .map_err(|error| format!("Could not set SSH write timeout: {error}"))?;

    let mut session =
        Session::new().map_err(|error| format!("Could not create SSH session: {error}"))?;

    session.set_tcp_stream(tcp);
    session.set_timeout(SSH_TIMEOUT_MS);

    session
        .handshake()
        .map_err(|error| format!("SSH handshake failed: {error}"))?;

    authenticate(&session, credentials)?;

    if !session.authenticated() {
        return Err("SSH authentication failed.".to_string());
    }

    Ok(session)
}

fn authenticate(session: &Session, credentials: &SshCredentials) -> Result<(), String> {
    let username = credentials.username.trim();

    if let Some(private_key_path) = credentials.private_key_path.as_deref() {
        let private_key_path = private_key_path.trim();

        if !private_key_path.is_empty() {
            session
                .userauth_pubkey_file(
                    username,
                    None,
                    Path::new(private_key_path),
                    credentials.passphrase.as_deref(),
                )
                .map_err(|error| format!("SSH private-key authentication failed: {error}"))?;

            return Ok(());
        }
    }

    if let Some(password) = credentials.password.as_deref() {
        session
            .userauth_password(username, password)
            .map_err(|error| format!("SSH password authentication failed: {error}"))?;

        return Ok(());
    }

    Err("Provide either a password or a private key path.".to_string())
}

fn file_name_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("/")
        .to_string()
}

fn remote_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_sftp_directory(perm: Option<u32>) -> bool {
    perm.map(|perm| (perm & SFTP_FILE_TYPE_MASK) == SFTP_DIRECTORY_TYPE)
        .unwrap_or(false)
}

fn is_sftp_regular_file(perm: Option<u32>) -> bool {
    perm.map(|perm| (perm & SFTP_FILE_TYPE_MASK) == SFTP_REGULAR_FILE_TYPE)
        .unwrap_or(false)
}

fn should_skip_remote_directory(name: &str) -> bool {
    name == "."
        || name == ".."
        || SKIPPED_REMOTE_DIRECTORIES
            .iter()
            .any(|skipped| skipped.eq_ignore_ascii_case(name))
}

fn is_supported_remote_code_file(path: &Path) -> bool {
    let file_name = match path.file_name().and_then(|name| name.to_str()) {
        Some(file_name) => file_name,
        None => return false,
    };

    if SUPPORTED_REMOTE_SPECIAL_FILES
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

    SUPPORTED_REMOTE_EXTENSIONS
        .iter()
        .any(|supported| supported == &extension.as_str())
}

fn read_remote_file_content(
    sftp: &Sftp,
    remote_path: &Path,
    known_size: u64,
) -> Result<RemoteFileContent, String> {
    if known_size > MAX_REMOTE_FILE_BYTES {
        return Err(format!(
            "Remote file is too large: {known_size} bytes. Limit is {MAX_REMOTE_FILE_BYTES} bytes."
        ));
    }

    let mut remote_file = sftp
        .open(remote_path)
        .map_err(|error| format!("Could not open remote file: {error}"))?;

    let mut content = String::new();

    remote_file
        .read_to_string(&mut content)
        .map_err(|error| format!("Could not read remote file as UTF-8 text: {error}"))?;

    Ok(RemoteFileContent {
        path: remote_path_string(remote_path),
        content,
        size: known_size,
    })
}

fn walk_remote_directory(
    sftp: &Sftp,
    current: &Path,
    depth: usize,
    files: &mut Vec<RemoteFileContent>,
) -> Result<(), String> {
    if depth > MAX_REMOTE_SCAN_DEPTH || files.len() >= MAX_REMOTE_DIRECTORY_FILES {
        return Ok(());
    }

    let entries = match sftp.readdir(current) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for (path, stat) in entries {
        if files.len() >= MAX_REMOTE_DIRECTORY_FILES {
            break;
        }

        let name = file_name_from_path(&path);

        if is_sftp_directory(stat.perm) {
            if should_skip_remote_directory(&name) {
                continue;
            }

            walk_remote_directory(sftp, &path, depth + 1, files)?;
            continue;
        }

        if !is_sftp_regular_file(stat.perm) || !is_supported_remote_code_file(&path) {
            continue;
        }

        let size = stat.size.unwrap_or(0);

        if size > MAX_REMOTE_FILE_BYTES {
            continue;
        }

        if let Ok(file) = read_remote_file_content(sftp, &path, size) {
            files.push(file);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_list_directory(request: SshListRequest) -> Result<Vec<RemoteFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect(&request.credentials)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("Could not open SFTP subsystem: {error}"))?;

        let remote_path = PathBuf::from(request.remote_path);
        let entries = sftp
            .readdir(&remote_path)
            .map_err(|error| format!("Could not read remote directory: {error}"))?;

        let mut files = entries
            .into_iter()
            .filter_map(|(path, stat)| {
                let name = file_name_from_path(&path);

                if name == "." || name == ".." {
                    return None;
                }

                Some(RemoteFileEntry {
                    path: remote_path_string(&path),
                    name,
                    is_directory: is_sftp_directory(stat.perm),
                    size: stat.size.unwrap_or(0),
                })
            })
            .collect::<Vec<_>>();

        files.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(files)
    })
    .await
    .map_err(|error| format!("SSH task failed: {error}"))?
}

#[tauri::command]
pub async fn ssh_read_file(request: SshReadRequest) -> Result<RemoteFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect(&request.credentials)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("Could not open SFTP subsystem: {error}"))?;

        let remote_path = PathBuf::from(&request.remote_path);

        let stat = sftp
            .stat(&remote_path)
            .map_err(|error| format!("Could not stat remote file: {error}"))?;

        let size = stat.size.unwrap_or(0);

        read_remote_file_content(&sftp, &remote_path, size)
    })
    .await
    .map_err(|error| format!("SSH task failed: {error}"))?
}

#[tauri::command]
pub async fn ssh_read_directory_files(
    app: AppHandle,
    request: SshReadDirectoryRequest,
) -> Result<Vec<RemoteFileContent>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let operation_id = request.operation_id.clone();

        emit_remote_directory_progress(
            &app,
            &operation_id,
            "scanning",
            0,
            0,
            Some(request.remote_path.clone()),
        );

        let session = connect(&request.credentials)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("Could not open SFTP subsystem: {error}"))?;

        let remote_path = PathBuf::from(&request.remote_path);

        let stat = sftp
            .stat(&remote_path)
            .map_err(|error| format!("Could not stat remote directory: {error}"))?;

        if !is_sftp_directory(stat.perm) {
            return Err("Selected remote path is not a directory.".to_string());
        }

        let mut candidates = Vec::new();

        collect_remote_directory_candidates(&sftp, &remote_path, 0, &mut candidates)?;

        candidates.sort_by(|a, b| a.0.cmp(&b.0));

        let total = candidates.len();

        emit_remote_directory_progress(
            &app,
            &operation_id,
            "reading",
            0,
            total,
            Some(request.remote_path.clone()),
        );

        let mut files = Vec::new();

        for (index, (path, size)) in candidates.iter().enumerate() {
            if let Ok(file) = read_remote_file_content(&sftp, path, *size) {
                files.push(file);
            }

            let completed = index + 1;

            emit_remote_directory_progress(
                &app,
                &operation_id,
                "reading",
                completed,
                total,
                Some(remote_path_string(path)),
            );
        }

        emit_remote_directory_progress(
            &app,
            &operation_id,
            "done",
            total,
            total,
            Some(request.remote_path),
        );

        Ok(files)
    })
    .await
    .map_err(|error| format!("SSH task failed: {error}"))?
}

#[tauri::command]
pub async fn ssh_download_file(request: SshDownloadRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect(&request.credentials)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("Could not open SFTP subsystem: {error}"))?;

        let remote_path = PathBuf::from(&request.remote_path);
        let local_path = PathBuf::from(&request.local_path);

        let mut remote_file = sftp
            .open(&remote_path)
            .map_err(|error| format!("Could not open remote file: {error}"))?;

        let mut local_file =
            File::create(&local_path).map_err(|error| format!("Could not create local file: {error}"))?;

        let mut buffer = [0_u8; 64 * 1024];

        loop {
            let bytes_read = remote_file
                .read(&mut buffer)
                .map_err(|error| format!("Could not read remote file: {error}"))?;

            if bytes_read == 0 {
                break;
            }

            local_file
                .write_all(&buffer[..bytes_read])
                .map_err(|error| format!("Could not write local file: {error}"))?;
        }

        Ok(())
    })
    .await
    .map_err(|error| format!("SSH task failed: {error}"))?
}