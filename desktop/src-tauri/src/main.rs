#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[cfg(test)]
use std::process::Output;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

const QUERY_PROGRESS_EVENT: &str = "quota-query-progress";
const PROGRESS_EMIT_PACE_MS: u64 = 25;
const FIXED_CACHE_DIR_NAME: &str = "cpa_codex_quota_cache";
const ALLOWED_EXTERNAL_URL_SCHEMES: &[&str] = &["http", "https"];

#[cfg(not(debug_assertions))]
const EMBEDDED_CODEX_SIDECAR: &[u8] = include_bytes!("../bin/codex_quota_checker_sidecar.exe");

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    #[serde(default)]
    cpa_base_url: String,
    #[serde(default)]
    management_key: String,
    #[serde(default)]
    backup_path: String,
    #[serde(default = "default_query_concurrency")]
    query_concurrency: u32,
    #[serde(default = "default_priority_plan_order")]
    priority_plan_order: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedAccountConfig {
    name: String,
    destination_path: String,
}

#[derive(Debug)]
struct StepProgressUpdate {
    completed: usize,
    total: usize,
    current_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrioritySyncChange {
    name: String,
    priority: i32,
}

fn default_query_concurrency() -> u32 {
    6
}

fn resolve_parallel_worker_count(total: usize, query_concurrency: u32) -> usize {
    if total == 0 {
        return 0;
    }
    total.min(std::cmp::max(1, query_concurrency as usize))
}

fn validate_external_url(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|error| format!("外部链接不是合法 URL: {error}"))?;
    if !ALLOWED_EXTERNAL_URL_SCHEMES.contains(&parsed.scheme()) {
        return Err(String::from("只允许打开 http 或 https 链接"));
    }
    Ok(parsed)
}

fn split_round_robin<T>(items: Vec<T>, worker_count: usize) -> Vec<Vec<T>> {
    let mut groups = (0..worker_count).map(|_| Vec::new()).collect::<Vec<_>>();
    for (index, item) in items.into_iter().enumerate() {
        groups[index % worker_count].push(item);
    }
    groups
}

fn default_priority_plan_order() -> Vec<String> {
    vec![
        String::from("team"),
        String::from("plus"),
        String::from("free"),
        String::from("pro 5x"),
        String::from("pro 20x"),
        String::from("unknown"),
    ]
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            cpa_base_url: String::new(),
            management_key: String::new(),
            backup_path: String::new(),
            query_concurrency: default_query_concurrency(),
            priority_plan_order: default_priority_plan_order(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequestEnvelope {
    command: String,
    args: Vec<String>,
    stdin_payload: Option<String>,
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResponseEnvelope {
    kind: Option<String>,
    ok: bool,
    payload: Option<Value>,
    error: Option<String>,
}

#[derive(Debug)]
enum WorkerMessage {
    Progress(Value),
    Result(Value),
}

#[derive(Default)]
struct WorkerState {
    inner: Arc<Mutex<Option<PersistentWorker>>>,
}

struct PersistentWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

fn apply_python_utf8_env(command: &mut Command) {
    // Windows 下 Python 管道默认可能退回本地代码页，进度 JSON 一旦带中文就会被 Rust 当成坏 UTF-8。
    command.env("PYTHONIOENCODING", "utf-8");
    command.env("PYTHONUTF8", "1");
}

#[cfg(windows)]
fn suppress_child_console(command: &mut Command) {
    // Tauri GUI 进程启动 PyInstaller sidecar 时，必须隐藏控制台窗口，保持单 exe 体验干净。
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_child_console(_command: &mut Command) {}

impl PersistentWorker {
    fn spawn(program: String, args: Vec<String>) -> Result<Self, String> {
        let mut command = Command::new(program);
        command.args(args);
        apply_python_utf8_env(&mut command);
        suppress_child_console(&mut command);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        // 常驻 worker 只消费 stdout 的 JSON 协议，stderr 改成丢弃，避免写满管道把子进程卡死。
        command.stderr(Stdio::null());

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| String::from("Python 常驻查询进程没有暴露 stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| String::from("Python 常驻查询进程没有暴露 stdout"))?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn send_request(
        &mut self,
        request: &WorkerRequestEnvelope,
        on_progress: &mut dyn FnMut(Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        let line = serde_json::to_string(request).map_err(|error| error.to_string())?;
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|error| error.to_string())?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;

        loop {
            let mut response_line = String::new();
            let read = self
                .stdout
                .read_line(&mut response_line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                let status = self.child.try_wait().ok().flatten();
                return match status {
                    Some(exit_status) => Err(format!("Python 常驻查询进程已退出: {exit_status}")),
                    None => Err(String::from("Python 常驻查询进程没有返回数据")),
                };
            }
            match parse_worker_response(&response_line)? {
                WorkerMessage::Progress(payload) => on_progress(payload)?,
                WorkerMessage::Result(payload) => return Ok(payload),
            }
        }
    }
}

impl Drop for PersistentWorker {
    fn drop(&mut self) {
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn app_data_dir_from_env(
    primary: Option<OsString>,
    secondary: Option<OsString>,
) -> Option<PathBuf> {
    primary
        .filter(|value| !value.is_empty())
        .or_else(|| secondary.filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn explicit_app_dir_from_env(env_key: &str) -> Option<PathBuf> {
    // 仅用于便携版冒烟和高级部署场景，不设置时完全遵循系统默认目录。
    std::env::var_os(env_key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn sibling_cache_dir_from_base_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(FIXED_CACHE_DIR_NAME)
}

fn payload_cache_file_path_from_cache_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("payload-cache.json")
}

fn runtime_config_file_path_from_cache_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("runtime-config.json")
}

#[cfg(not(debug_assertions))]
fn current_executable_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| String::from("无法定位程序目录"))
}

#[cfg(debug_assertions)]
fn preferred_fixed_cache_dir() -> Result<PathBuf, String> {
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    Ok(sibling_cache_dir_from_base_dir(&workspace_root))
}

#[cfg(not(debug_assertions))]
fn preferred_fixed_cache_dir() -> Result<PathBuf, String> {
    Ok(sibling_cache_dir_from_base_dir(&current_executable_dir()?))
}

fn fallback_app_config_dir() -> Result<PathBuf, String> {
    // 便携版在极简 Windows 用户环境里可能拿不到 Known Folder，回退到环境变量目录。
    app_data_dir_from_env(
        std::env::var_os("APPDATA"),
        std::env::var_os("LOCALAPPDATA"),
    )
    .map(|base_dir| base_dir.join("com.cpa.quota.desk"))
    .ok_or_else(|| String::from("无法定位应用配置目录"))
}

fn fallback_app_cache_dir() -> Result<PathBuf, String> {
    // 固定目录不可用时，再回退到系统缓存根，并继续挂上统一的缓存目录名。
    app_data_dir_from_env(
        std::env::var_os("LOCALAPPDATA"),
        std::env::var_os("APPDATA"),
    )
    .map(|base_dir| sibling_cache_dir_from_base_dir(&base_dir))
    .ok_or_else(|| String::from("无法定位应用缓存目录"))
}

fn resolve_app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = explicit_app_dir_from_env("CPA_QUOTA_DESK_CONFIG_DIR") {
        return Ok(path);
    }
    match app.path().app_config_dir() {
        Ok(path) => Ok(path),
        Err(_) => fallback_app_config_dir(),
    }
}

fn resolve_app_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = explicit_app_dir_from_env("CPA_QUOTA_DESK_CACHE_DIR") {
        return Ok(path);
    }
    if let Ok(path) = preferred_fixed_cache_dir() {
        return Ok(path);
    }
    match app.path().app_cache_dir() {
        Ok(path) => Ok(sibling_cache_dir_from_base_dir(&path)),
        Err(_) => fallback_app_cache_dir(),
    }
}

fn runtime_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = resolve_app_cache_dir(app)?;
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    Ok(runtime_config_file_path_from_cache_dir(&cache_dir))
}

fn payload_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = resolve_app_cache_dir(app)?;
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    Ok(payload_cache_file_path_from_cache_dir(&cache_dir))
}

fn legacy_runtime_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_app_config_dir(app)?.join("runtime-config.json"))
}

#[cfg(any(test, not(debug_assertions)))]
fn sidecar_payload_hash(bytes: &[u8]) -> u64 {
    // 用轻量 FNV-1a 把 sidecar 内容放进文件名，避免覆盖正在运行的旧版本。
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(any(test, not(debug_assertions)))]
fn embedded_sidecar_cache_path(cache_dir: &Path, bytes: &[u8]) -> PathBuf {
    cache_dir.join("sidecar").join(format!(
        "codex_quota_checker_sidecar-{}-{:016x}.exe",
        env!("CARGO_PKG_VERSION"),
        sidecar_payload_hash(bytes)
    ))
}

#[cfg(any(test, not(debug_assertions)))]
fn ensure_embedded_sidecar_file(cache_dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let sidecar_path = embedded_sidecar_cache_path(cache_dir, bytes);
    if sidecar_path.is_file() {
        let current = fs::read(&sidecar_path)
            .map_err(|error| format!("读取内嵌查询程序缓存失败: {error}"))?;
        if current == bytes {
            return Ok(sidecar_path);
        }
    }

    let parent = sidecar_path
        .parent()
        .ok_or_else(|| String::from("无法定位内嵌查询程序缓存目录"))?;
    fs::create_dir_all(parent).map_err(|error| format!("创建内嵌查询程序缓存目录失败: {error}"))?;

    let temp_path = sidecar_path.with_extension("exe.tmp");
    fs::write(&temp_path, bytes).map_err(|error| format!("写入内嵌查询程序失败: {error}"))?;
    if sidecar_path.exists() {
        fs::remove_file(&sidecar_path).map_err(|error| format!("替换旧查询程序失败: {error}"))?;
    }
    fs::rename(&temp_path, &sidecar_path)
        .map_err(|error| format!("启用内嵌查询程序失败: {error}"))?;
    Ok(sidecar_path)
}

fn resolve_python_program(_app: &AppHandle) -> Result<(String, Vec<String>), String> {
    #[cfg(debug_assertions)]
    {
        let script_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("codex_quota_checker.py");
        Ok((
            String::from("python"),
            vec![script_path.to_string_lossy().to_string()],
        ))
    }

    #[cfg(not(debug_assertions))]
    {
        let executable_dir = current_executable_dir()?;
        let sidecar_path = executable_dir.join("codex_quota_checker_sidecar.exe");
        if sidecar_path.is_file() {
            return Ok((sidecar_path.to_string_lossy().to_string(), Vec::new()));
        }
        let cache_dir = resolve_app_cache_dir(_app)?;
        let embedded_sidecar = ensure_embedded_sidecar_file(&cache_dir, EMBEDDED_CODEX_SIDECAR)?;
        Ok((embedded_sidecar.to_string_lossy().to_string(), Vec::new()))
    }
}

fn build_worker_process_args(mut prefix_args: Vec<String>) -> Vec<String> {
    // Python 脚本和 sidecar 都统一追加 worker 子命令，复用同一条请求协议。
    prefix_args.push(String::from("worker"));
    prefix_args
}

fn is_safe_auth_file_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return false;
    }
    if !trimmed.to_ascii_lowercase().ends_with(".json") {
        return false;
    }
    if trimmed.contains(['/', '\\']) {
        return false;
    }
    Path::new(trimmed)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn resolve_cpa_base_url(config: &RuntimeConfig) -> Result<Url, String> {
    let raw = config.cpa_base_url.trim();
    if raw.is_empty() {
        return Err(String::from("缺少 CPA 地址，请先在界面里填写"));
    }
    Url::parse(raw).map_err(|error| format!("CPA 地址不合法: {error}"))
}

fn build_auth_file_download_url(base_url: &Url, name: &str) -> Result<Url, String> {
    if !is_safe_auth_file_name(name) {
        return Err(format!("账号配置文件名不合法: {name}"));
    }
    let mut url = base_url.clone();
    // 无论配置里是否带路径，这里都强制走 CPA 既有的管理下载接口。
    url.set_path("/v0/management/auth-files/download");
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        query.append_pair("name", name.trim());
    }
    Ok(url)
}

fn build_auth_file_fields_url(base_url: &Url) -> Url {
    let mut url = base_url.clone();
    // 优先级写回统一收口到 CPA 现有 fields 接口，避免前端自行拼路由。
    url.set_path("/v0/management/auth-files/fields");
    url.set_query(None);
    url
}

fn apply_management_auth(
    request: reqwest::blocking::RequestBuilder,
    management_key: &str,
) -> reqwest::blocking::RequestBuilder {
    let trimmed = management_key.trim();
    if trimmed.is_empty() {
        return request;
    }
    // 线上管理接口历史上同时接受 Bearer 和 X-Management-Key，这里双写保证兼容旧链路。
    request
        .bearer_auth(trimmed)
        .header("X-Management-Key", trimmed)
}

fn emit_step_progress(
    app: &AppHandle,
    request_id: &str,
    completed: usize,
    total: usize,
    current_label: &str,
) -> Result<(), String> {
    app.emit(
        QUERY_PROGRESS_EVENT,
        serde_json::json!({
            "requestId": request_id,
            "completed": completed,
            "total": total,
            "currentLabel": current_label,
            "authIndex": "",
            "status": "",
            "timingsMs": {},
        }),
    )
    .map_err(|error| format!("发送进度事件失败: {error}"))
}

#[derive(Debug)]
enum DownloadWorkerMessage {
    Completed {
        index: usize,
        item: DownloadedAccountConfig,
    },
    Failed(String),
}

#[derive(Debug)]
enum PrioritySyncWorkerMessage {
    Completed { name: String },
    Failed(String),
}

fn download_selected_accounts_sync_with_progress(
    config: RuntimeConfig,
    auth_file_names: Vec<String>,
    on_progress: &mut dyn FnMut(usize, usize, &str) -> Result<(), String>,
) -> Result<Vec<DownloadedAccountConfig>, String> {
    let filtered_names = auth_file_names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    let total = filtered_names.len();
    if total == 0 {
        return Ok(Vec::new());
    }

    let backup_path = config.backup_path.trim();
    if backup_path.is_empty() {
        return Err(String::from("请先配置账号备份路径"));
    }

    let base_url = resolve_cpa_base_url(&config)?;
    let backup_dir = PathBuf::from(backup_path);
    fs::create_dir_all(&backup_dir).map_err(|error| format!("创建账号备份目录失败: {error}"))?;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("初始化下载客户端失败: {error}"))?;
    let management_key = config.management_key.trim().to_string();
    let worker_count = resolve_parallel_worker_count(total, config.query_concurrency);
    let grouped_jobs = split_round_robin(
        filtered_names
            .into_iter()
            .enumerate()
            .collect::<Vec<(usize, String)>>(),
        worker_count,
    );
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let (message_tx, message_rx) = mpsc::channel::<DownloadWorkerMessage>();
    let mut handles = Vec::new();

    for jobs in grouped_jobs.into_iter().filter(|group| !group.is_empty()) {
        let worker_client = client.clone();
        let worker_base_url = base_url.clone();
        let worker_management_key = management_key.clone();
        let worker_backup_dir = backup_dir.clone();
        let worker_cancel_flag = Arc::clone(&cancel_flag);
        let worker_message_tx = message_tx.clone();
        handles.push(thread::spawn(move || {
            for (index, name) in jobs {
                if worker_cancel_flag.load(Ordering::Relaxed) {
                    break;
                }
                let result = (|| -> Result<DownloadedAccountConfig, String> {
                    let url = build_auth_file_download_url(&worker_base_url, &name)?;
                    let response =
                        apply_management_auth(worker_client.get(url), &worker_management_key)
                            .send()
                            .map_err(|error| format!("下载 {name} 失败: {error}"))?;
                    let status = response.status();
                    if !status.is_success() {
                        let detail = response.text().unwrap_or_default();
                        let message = detail.trim();
                        if message.is_empty() {
                            return Err(format!("下载 {name} 失败: HTTP {}", status.as_u16()));
                        }
                        return Err(format!(
                            "下载 {name} 失败: HTTP {} {}",
                            status.as_u16(),
                            message
                        ));
                    }
                    let content = response
                        .bytes()
                        .map_err(|error| format!("读取 {name} 下载内容失败: {error}"))?;
                    let destination = worker_backup_dir.join(&name);
                    fs::write(&destination, &content)
                        .map_err(|error| format!("写入备份文件 {name} 失败: {error}"))?;
                    Ok(DownloadedAccountConfig {
                        name: name.to_string(),
                        destination_path: destination.to_string_lossy().to_string(),
                    })
                })();

                match result {
                    Ok(item) => {
                        if worker_message_tx
                            .send(DownloadWorkerMessage::Completed { index, item })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        worker_cancel_flag.store(true, Ordering::Relaxed);
                        let _ = worker_message_tx.send(DownloadWorkerMessage::Failed(error));
                        break;
                    }
                }
            }
        }));
    }
    drop(message_tx);

    let mut first_error: Option<String> = None;
    let mut downloaded = std::iter::repeat_with(|| None)
        .take(total)
        .collect::<Vec<Option<DownloadedAccountConfig>>>();
    let mut completed = 0;

    for message in message_rx {
        match message {
            DownloadWorkerMessage::Completed { index, item } => {
                completed += 1;
                let current_name = item.name.clone();
                downloaded[index] = Some(item);
                if let Err(error) = on_progress(completed, total, &current_name) {
                    // 进度通道一旦断开，就让所有工作线程尽快停下，避免继续做无用下载。
                    first_error = Some(error);
                    cancel_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
            DownloadWorkerMessage::Failed(error) => {
                first_error = Some(error);
                cancel_flag.store(true, Ordering::Relaxed);
                break;
            }
        }
    }

    for handle in handles {
        handle
            .join()
            .map_err(|_| String::from("备份工作线程异常退出"))?;
    }
    if let Some(error) = first_error {
        return Err(error);
    }

    Ok(downloaded.into_iter().flatten().collect())
}

fn sync_account_priorities_sync_with_progress(
    config: RuntimeConfig,
    changes: Vec<PrioritySyncChange>,
    on_progress: &mut dyn FnMut(usize, usize, &str) -> Result<(), String>,
) -> Result<(), String> {
    let total = changes.len();
    if total == 0 {
        return Ok(());
    }

    let base_url = resolve_cpa_base_url(&config)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("初始化同步客户端失败: {error}"))?;
    let management_key = config.management_key.trim().to_string();
    let url = build_auth_file_fields_url(&base_url);
    let worker_count = resolve_parallel_worker_count(total, config.query_concurrency);
    let grouped_jobs = split_round_robin(
        changes
            .into_iter()
            .enumerate()
            .collect::<Vec<(usize, PrioritySyncChange)>>(),
        worker_count,
    );
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let (message_tx, message_rx) = mpsc::channel::<PrioritySyncWorkerMessage>();
    let mut handles = Vec::new();

    for jobs in grouped_jobs.into_iter().filter(|group| !group.is_empty()) {
        let worker_client = client.clone();
        let worker_url = url.clone();
        let worker_management_key = management_key.clone();
        let worker_cancel_flag = Arc::clone(&cancel_flag);
        let worker_message_tx = message_tx.clone();
        handles.push(thread::spawn(move || {
            for (_index, change) in jobs {
                if worker_cancel_flag.load(Ordering::Relaxed) {
                    break;
                }
                let name = change.name.trim().to_string();
                let result = (|| -> Result<(), String> {
                    if !is_safe_auth_file_name(&name) {
                        return Err(format!("同步账号失败，账号配置文件名不合法: {name}"));
                    }

                    let body = serde_json::to_vec(&serde_json::json!({
                        "name": name.clone(),
                        "priority": change.priority,
                    }))
                    .map_err(|error| format!("构造 {name} 同步请求失败: {error}"))?;
                    let request = worker_client
                        .patch(worker_url.clone())
                        .header("content-type", "application/json; charset=utf-8")
                        .body(body);
                    let response = apply_management_auth(request, &worker_management_key)
                        .send()
                        .map_err(|error| format!("同步 {name} 失败: {error}"))?;
                    let status = response.status();
                    if !status.is_success() {
                        let detail = response.text().unwrap_or_default();
                        let message = detail.trim();
                        if message.is_empty() {
                            return Err(format!("同步 {name} 失败: HTTP {}", status.as_u16()));
                        }
                        return Err(format!(
                            "同步 {name} 失败: HTTP {} {}",
                            status.as_u16(),
                            message
                        ));
                    }
                    Ok(())
                })();

                match result {
                    Ok(()) => {
                        if worker_message_tx
                            .send(PrioritySyncWorkerMessage::Completed { name })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        worker_cancel_flag.store(true, Ordering::Relaxed);
                        let _ = worker_message_tx.send(PrioritySyncWorkerMessage::Failed(error));
                        break;
                    }
                }
            }
        }));
    }
    drop(message_tx);

    let mut first_error: Option<String> = None;
    let mut completed = 0;

    for message in message_rx {
        match message {
            PrioritySyncWorkerMessage::Completed { name } => {
                completed += 1;
                if let Err(error) = on_progress(completed, total, &name) {
                    // 同步进度发不出去时不再继续排队补请求，避免用户界面和远端状态脱节。
                    first_error = Some(error);
                    cancel_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
            PrioritySyncWorkerMessage::Failed(error) => {
                first_error = Some(error);
                cancel_flag.store(true, Ordering::Relaxed);
                break;
            }
        }
    }

    for handle in handles {
        handle
            .join()
            .map_err(|_| String::from("同步工作线程异常退出"))?;
    }
    if let Some(error) = first_error {
        return Err(error);
    }

    Ok(())
}

fn should_emit_progress(command: &str) -> bool {
    matches!(
        command,
        "query-records" | "query-all" | "query-one" | "query-many"
    )
}

async fn run_blocking_progress_task<T, F>(
    app: AppHandle,
    request_id: Option<String>,
    worker: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(tokio::sync::mpsc::UnboundedSender<StepProgressUpdate>) -> Result<T, String>
        + Send
        + 'static,
{
    let (progress_tx, mut progress_rx) =
        tokio::sync::mpsc::unbounded_channel::<StepProgressUpdate>();
    let emit_request_id = request_id.clone();
    let worker_handle = tauri::async_runtime::spawn_blocking(move || worker(progress_tx));

    while let Some(update) = progress_rx.recv().await {
        // 进度事件统一在异步命令层发回前端，避免后台工作线程发射太快时 WebView 吞掉中间帧。
        if let Some(request_id) = emit_request_id.as_deref() {
            emit_step_progress(
                &app,
                request_id,
                update.completed,
                update.total,
                &update.current_label,
            )?;
            // 小文件备份会瞬间完成，轻微节流能让真实窗口有机会绘制中间进度。
            tokio::time::sleep(Duration::from_millis(PROGRESS_EMIT_PACE_MS)).await;
        }
    }

    worker_handle.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
fn run_command_with_optional_stdin(
    mut command: Command,
    stdin_payload: Option<String>,
) -> std::io::Result<Output> {
    apply_python_utf8_env(&mut command);
    suppress_child_console(&mut command);
    if stdin_payload.is_some() {
        command.stdin(Stdio::piped());
    }
    // 必须显式接管 stdout/stderr，wait_with_output 才能把 Python JSON 收回给桌面端。
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn()?;
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            // 缓存账号列表经 stdin 传给 Python，避免为了查询再拉一遍 auth-files。
            stdin.write_all(payload.as_bytes())?;
        }
    }
    child.wait_with_output()
}

#[tauri::command]
async fn run_python_query(
    app: AppHandle,
    worker_state: State<'_, WorkerState>,
    command: String,
    mut args: Vec<String>,
    stdin_payload: Option<String>,
    request_id: Option<String>,
) -> Result<Value, String> {
    if should_emit_progress(&command) {
        args.push(String::from("--emit-progress"));
    }
    let (program, prefix_args) = resolve_python_program(&app)?;
    let worker_args = build_worker_process_args(prefix_args);
    let request = WorkerRequestEnvelope {
        command: command.clone(),
        args,
        stdin_payload,
        request_id,
    };
    let worker_state = worker_state.inner.clone();
    // 查询请求仍放后台线程执行，但现在复用同一个 Python 进程，避免频繁冷启动。
    tauri::async_runtime::spawn_blocking(move || {
        run_worker_request(app, worker_state, program, worker_args, request)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[cfg(test)]
fn parse_python_json_output(stdout: &str) -> Result<Value, String> {
    let trimmed = stdout.trim_matches(|current: char| {
        current.is_whitespace() || current == '\u{feff}' || current == '\0'
    });
    if trimmed.is_empty() {
        return Err(String::from("Python 查询进程没有返回 JSON 数据"));
    }
    serde_json::from_str(trimmed).map_err(|error| {
        let snippet: String = trimmed.chars().take(180).collect();
        format!("Python 查询结果不是合法 JSON: {error}; 输出片段: {snippet}")
    })
}

fn parse_worker_response(stdout: &str) -> Result<WorkerMessage, String> {
    let trimmed = stdout.trim_matches(|current: char| {
        current.is_whitespace() || current == '\u{feff}' || current == '\0'
    });
    if trimmed.is_empty() {
        return Err(String::from("Python 常驻查询进程没有返回 JSON 数据"));
    }
    let envelope: WorkerResponseEnvelope = serde_json::from_str(trimmed).map_err(|error| {
        let snippet: String = trimmed.chars().take(180).collect();
        format!("Python 常驻查询结果不是合法 JSON: {error}; 输出片段: {snippet}")
    })?;
    if envelope.ok {
        let payload = envelope
            .payload
            .unwrap_or(Value::Object(Default::default()));
        if envelope.kind.as_deref() == Some("progress") {
            Ok(WorkerMessage::Progress(payload))
        } else {
            Ok(WorkerMessage::Result(payload))
        }
    } else {
        Err(envelope
            .error
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| String::from("Python 常驻查询进程返回失败")))
    }
}

fn run_worker_request(
    app: AppHandle,
    worker_state: Arc<Mutex<Option<PersistentWorker>>>,
    program: String,
    worker_args: Vec<String>,
    request: WorkerRequestEnvelope,
) -> Result<Value, String> {
    let mut guard = worker_state
        .lock()
        .map_err(|_| String::from("Python 常驻查询状态锁已损坏"))?;

    if guard.is_none() {
        *guard = Some(PersistentWorker::spawn(
            program.clone(),
            worker_args.clone(),
        )?);
    }

    let mut emit_progress = |payload: Value| {
        // 进度事件只是附加能力，发不出去时记录日志即可，不能把整轮额度查询判成失败。
        if let Err(error) = app.emit(QUERY_PROGRESS_EVENT, payload) {
            eprintln!("failed to emit quota progress event: {error}");
        }
        Ok(())
    };
    let first_result = guard
        .as_mut()
        .ok_or_else(|| String::from("Python 常驻查询进程未初始化"))?
        .send_request(&request, &mut emit_progress);
    match first_result {
        Ok(payload) => Ok(payload),
        Err(first_error) => {
            // 旧进程如果已经断了，先丢掉，再只重启一次避免死循环。
            *guard = Some(PersistentWorker::spawn(program, worker_args).map_err(
                |spawn_error| {
                    format!("Python 常驻查询进程重启失败: {spawn_error}; 首次错误: {first_error}")
                },
            )?);
            guard
                .as_mut()
                .ok_or_else(|| String::from("Python 常驻查询进程重启后不可用"))?
                .send_request(&request, &mut emit_progress)
                .map_err(|retry_error| {
                    format!("Python 常驻查询进程失败: {retry_error}; 首次错误: {first_error}")
                })
        }
    }
}

fn read_runtime_config_from_path(path: &Path) -> Result<Option<RuntimeConfig>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let config = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    Ok(Some(config))
}

fn stop_persistent_worker(worker_state: &WorkerState) -> Result<(), String> {
    let mut guard = worker_state
        .inner
        .lock()
        .map_err(|_| String::from("Python 常驻查询状态锁已损坏"))?;
    // 直接丢掉持有的 worker，让 Drop 去关闭 sidecar，后续删缓存目录时不会被文件锁卡住。
    *guard = None;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    remove_path_with_retry(path, || fs::remove_file(path))
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    remove_path_with_retry(path, || fs::remove_dir_all(path))
}

fn remove_path_with_retry(
    path: &Path,
    mut remover: impl FnMut() -> std::io::Result<()>,
) -> Result<(), String> {
    let mut last_error: Option<std::io::Error> = None;
    for attempt in 0..8 {
        match remover() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Other
                ) && attempt < 7 =>
            {
                last_error = Some(error);
                // Windows 关闭 sidecar 后，文件锁释放有时会滞后几十毫秒，这里做短重试兜底。
                thread::sleep(Duration::from_millis(80));
            }
            Err(error) => return Err(format!("{}: {}", path.display(), error)),
        }
    }
    match last_error {
        Some(error) => Err(format!("{}: {}", path.display(), error)),
        None => Ok(()),
    }
}

fn clear_directory_contents(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let child_path = entry.path();
        if child_path.is_dir() {
            remove_dir_if_exists(&child_path)?;
        } else {
            remove_file_if_exists(&child_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn load_runtime_config(app: AppHandle) -> Result<RuntimeConfig, String> {
    let path = runtime_config_path(&app)?;
    if let Some(config) = read_runtime_config_from_path(&path)? {
        return Ok(config);
    }
    let legacy_path = legacy_runtime_config_path(&app)?;
    if let Some(config) = read_runtime_config_from_path(&legacy_path)? {
        let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
        fs::write(&path, content).map_err(|error| error.to_string())?;
        let _ = fs::remove_file(&legacy_path);
        return Ok(config);
    }
    Ok(RuntimeConfig::default())
}

#[tauri::command]
fn save_runtime_config(app: AppHandle, config: RuntimeConfig) -> Result<(), String> {
    let path = runtime_config_path(&app)?;
    let content = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_payload_cache(app: AppHandle) -> Result<Option<Value>, String> {
    let path = payload_cache_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let payload: Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    Ok(Some(payload))
}

#[tauri::command]
fn save_payload_cache(app: AppHandle, payload: Value) -> Result<(), String> {
    let path = payload_cache_path(&app)?;
    let content = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_local_cache(app: AppHandle, worker_state: State<'_, WorkerState>) -> Result<(), String> {
    stop_persistent_worker(&worker_state)?;
    let cache_dir = resolve_app_cache_dir(&app)?;
    clear_directory_contents(&cache_dir)?;
    remove_file_if_exists(&legacy_runtime_config_path(&app)?)?;
    Ok(())
}

#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("打开外部链接失败: {error}"))
}

#[tauri::command]
async fn download_selected_accounts(
    app: AppHandle,
    config: RuntimeConfig,
    auth_file_names: Vec<String>,
    request_id: Option<String>,
) -> Result<Vec<DownloadedAccountConfig>, String> {
    run_blocking_progress_task(app, request_id, move |progress_tx| {
        let mut on_progress = |completed: usize, total: usize, current_label: &str| {
            progress_tx
                .send(StepProgressUpdate {
                    completed,
                    total,
                    current_label: current_label.to_string(),
                })
                .map_err(|_| String::from("备份进度通道已关闭"))?;
            Ok(())
        };
        download_selected_accounts_sync_with_progress(config, auth_file_names, &mut on_progress)
    })
    .await
}

#[tauri::command]
async fn sync_account_priorities(
    app: AppHandle,
    config: RuntimeConfig,
    changes: Vec<PrioritySyncChange>,
    request_id: Option<String>,
) -> Result<(), String> {
    run_blocking_progress_task(app, request_id, move |progress_tx| {
        let mut on_progress = |completed: usize, total: usize, current_label: &str| {
            progress_tx
                .send(StepProgressUpdate {
                    completed,
                    total,
                    current_label: current_label.to_string(),
                })
                .map_err(|_| String::from("同步进度通道已关闭"))?;
            Ok(())
        };
        sync_account_priorities_sync_with_progress(config, changes, &mut on_progress)
    })
    .await
}

fn main() {
    // 桌面端所有外部 IO 都经由命令层收口，前端只处理显示和交互。
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(WorkerState::default())
        .invoke_handler(tauri::generate_handler![
            run_python_query,
            load_runtime_config,
            save_runtime_config,
            load_payload_cache,
            save_payload_cache,
            clear_local_cache,
            open_external_url,
            download_selected_accounts,
            sync_account_priorities
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}

#[cfg(test)]
mod tests {
    use super::{
        app_data_dir_from_env, build_auth_file_download_url, build_auth_file_fields_url,
        clear_directory_contents,
        download_selected_accounts_sync_with_progress, embedded_sidecar_cache_path,
        ensure_embedded_sidecar_file, is_safe_auth_file_name, parse_python_json_output,
        parse_worker_response, payload_cache_file_path_from_cache_dir, resolve_cpa_base_url,
        resolve_parallel_worker_count, run_command_with_optional_stdin,
        runtime_config_file_path_from_cache_dir,
        sibling_cache_dir_from_base_dir, sync_account_priorities_sync_with_progress,
        validate_external_url, DownloadedAccountConfig, PersistentWorker, PrioritySyncChange, RuntimeConfig,
        WorkerMessage, WorkerRequestEnvelope,
    };
    use reqwest::Url;
    use serde_json::Value;
    use std::{
        ffi::OsString,
        fs,
        io::{Read, Write},
        path::PathBuf,
        process::Command,
        thread,
    };

    #[test]
    fn parse_python_json_output_rejects_empty_stdout() {
        let result = parse_python_json_output("");
        assert_eq!(result.unwrap_err(), "Python 查询进程没有返回 JSON 数据");
    }

    #[test]
    fn app_data_dir_from_env_prefers_primary_value() {
        let path = app_data_dir_from_env(
            Some(OsString::from("C:\\Users\\mark\\AppData\\Roaming")),
            Some(OsString::from("C:\\Users\\mark\\AppData\\Local")),
        )
        .expect("expected primary app data dir");

        assert_eq!(path, PathBuf::from("C:\\Users\\mark\\AppData\\Roaming"));
    }

    #[test]
    fn app_data_dir_from_env_falls_back_to_secondary_value() {
        let path = app_data_dir_from_env(
            Some(OsString::new()),
            Some(OsString::from("C:\\Users\\mark\\AppData\\Local")),
        )
        .expect("expected secondary app data dir");

        assert_eq!(path, PathBuf::from("C:\\Users\\mark\\AppData\\Local"));
    }

    #[test]
    fn sibling_cache_dir_from_base_dir_appends_fixed_cache_folder_name() {
        let cache_dir = sibling_cache_dir_from_base_dir(PathBuf::from("D:\\work\\cpa").as_path());

        assert_eq!(cache_dir, PathBuf::from("D:\\work\\cpa\\cpa_codex_quota_cache"));
    }

    #[test]
    fn payload_cache_file_path_from_cache_dir_uses_fixed_cache_root() {
        let payload_path =
            payload_cache_file_path_from_cache_dir(PathBuf::from("D:\\work\\cpa\\cpa_codex_quota_cache").as_path());

        assert_eq!(
            payload_path,
            PathBuf::from("D:\\work\\cpa\\cpa_codex_quota_cache\\payload-cache.json")
        );
    }

    #[test]
    fn runtime_config_file_path_from_cache_dir_uses_fixed_cache_root() {
        let runtime_config_path =
            runtime_config_file_path_from_cache_dir(PathBuf::from("D:\\work\\cpa\\cpa_codex_quota_cache").as_path());

        assert_eq!(
            runtime_config_path,
            PathBuf::from("D:\\work\\cpa\\cpa_codex_quota_cache\\runtime-config.json")
        );
    }

    #[test]
    fn clear_directory_contents_keeps_root_and_removes_children() {
        let cache_dir = tempfile::tempdir().expect("expected temp dir");
        let nested_dir = cache_dir.path().join("sidecar");
        fs::create_dir_all(&nested_dir).expect("expected nested dir");
        fs::write(cache_dir.path().join("runtime-config.json"), b"demo").expect("expected config");
        fs::write(nested_dir.join("worker.exe"), b"demo").expect("expected worker");

        clear_directory_contents(cache_dir.path()).expect("expected cache cleanup");

        assert!(cache_dir.path().is_dir());
        assert!(
            fs::read_dir(cache_dir.path())
                .expect("expected cache root entries")
                .next()
                .is_none()
        );
    }

    #[test]
    fn run_command_with_optional_stdin_captures_child_stdout_and_stderr() {
        // 用最小 Python 进程覆盖真实问题，确保桌面端能收回 stdout/stderr。
        let mut command = Command::new("python");
        command.args([
            "-c",
            "import sys; sys.stderr.write('warn\\n'); print('{\"ok\": true}')",
        ]);

        let output = run_command_with_optional_stdin(command, None).expect("expected child output");

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "{\"ok\": true}"
        );
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), "warn");
    }

    #[test]
    fn run_command_with_optional_stdin_passes_payload_to_child_stdin() {
        // stdin 仍要保持可用，否则 query-records 会在修复 stdout 后退化。
        let mut command = Command::new("python");
        command.args([
            "-c",
            "import sys; data = sys.stdin.read(); print('{\"payload\": \"%s\"}' % data)",
        ]);

        let output = run_command_with_optional_stdin(command, Some(String::from("demo")))
            .expect("expected child output");

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "{\"payload\": \"demo\"}"
        );
    }

    #[test]
    fn parse_worker_response_rejects_error_envelope() {
        let result = parse_worker_response("{\"ok\":false,\"error\":\"worker failed\"}");

        assert_eq!(result.unwrap_err(), "worker failed");
    }

    #[test]
    fn parse_worker_response_marks_progress_messages() {
        let result = parse_worker_response(
            "{\"kind\":\"progress\",\"ok\":true,\"payload\":{\"completed\":1}}",
        )
        .expect("expected progress message");

        match result {
            WorkerMessage::Progress(payload) => {
                assert_eq!(payload.get("completed").and_then(Value::as_u64), Some(1));
            }
            WorkerMessage::Result(_) => panic!("expected progress payload"),
        }
    }

    #[test]
    fn persistent_worker_reuses_single_child_for_multiple_requests() {
        // 用一个极小的 Python 回环进程证明两次请求都落到同一个子进程里。
        let script = r#"
import json
import sys

counter = 0
for line in sys.stdin:
    request = json.loads(line)
    counter += 1
    print(json.dumps({
        "ok": True,
        "payload": {
            "command": request["command"],
            "counter": counter,
        }
    }), flush=True)
"#;

        let mut worker = PersistentWorker::spawn(
            String::from("python"),
            vec![String::from("-c"), String::from(script)],
        )
        .expect("expected worker process");
        let mut ignore_progress = |_payload: Value| -> Result<(), String> { Ok(()) };

        let first = worker
            .send_request(
                &WorkerRequestEnvelope {
                    command: String::from("list"),
                    args: vec![String::from("--json")],
                    stdin_payload: None,
                    request_id: None,
                },
                &mut ignore_progress,
            )
            .expect("expected first response");
        let second = worker
            .send_request(
                &WorkerRequestEnvelope {
                    command: String::from("query-records"),
                    args: vec![String::from("--json")],
                    stdin_payload: Some(String::from("[{\"auth_index\":\"idx-a\"}]")),
                    request_id: Some(String::from("req-1")),
                },
                &mut ignore_progress,
            )
            .expect("expected second response");

        assert_eq!(first.get("command").and_then(Value::as_str), Some("list"));
        assert_eq!(first.get("counter").and_then(Value::as_u64), Some(1));
        assert_eq!(
            second.get("command").and_then(Value::as_str),
            Some("query-records")
        );
        assert_eq!(second.get("counter").and_then(Value::as_u64), Some(2));
    }

    #[test]
    fn safe_auth_file_name_rejects_path_traversal() {
        assert!(is_safe_auth_file_name("codex-a.json"));
        assert!(!is_safe_auth_file_name("../secret.json"));
        assert!(!is_safe_auth_file_name(r"..\secret.json"));
        assert!(!is_safe_auth_file_name("nested/demo.json"));
        assert!(!is_safe_auth_file_name("demo.txt"));
    }

    #[test]
    fn resolve_cpa_base_url_rejects_empty_value() {
        let error = resolve_cpa_base_url(&RuntimeConfig::default()).expect_err("expected missing base url error");

        assert_eq!(error, "缺少 CPA 地址，请先在界面里填写");
    }

    #[test]
    fn build_auth_file_download_url_points_to_management_download_route() {
        let base = Url::parse("https://cpa.example/custom").expect("expected base url");
        let url =
            build_auth_file_download_url(&base, "codex-a.json").expect("expected download url");

        assert_eq!(
            url.as_str(),
            "https://cpa.example/v0/management/auth-files/download?name=codex-a.json"
        );
    }

    #[test]
    fn build_auth_file_fields_url_points_to_management_fields_route() {
        let base = Url::parse("https://cpa.example/custom?demo=1").expect("expected base url");
        let url = build_auth_file_fields_url(&base);

        assert_eq!(
            url.as_str(),
            "https://cpa.example/v0/management/auth-files/fields"
        );
    }

    #[test]
    fn resolve_parallel_worker_count_caps_by_total_and_query_concurrency() {
        assert_eq!(resolve_parallel_worker_count(0, 6), 0);
        assert_eq!(resolve_parallel_worker_count(3, 1), 1);
        assert_eq!(resolve_parallel_worker_count(3, 2), 2);
        assert_eq!(resolve_parallel_worker_count(3, 9), 3);
    }

    #[test]
    fn validate_external_url_accepts_https() {
        let parsed = validate_external_url("https://github.com/MarkLunaCoder/CPA_Codex_Quota_Mgt")
            .expect("expected https url to pass");

        assert_eq!(parsed.scheme(), "https");
    }

    #[test]
    fn validate_external_url_rejects_non_http_scheme() {
        let error = validate_external_url("javascript:alert(1)")
            .expect_err("expected javascript url to be rejected");

        assert!(error.contains("http 或 https"));
    }

    #[test]
    fn embedded_sidecar_cache_path_contains_version_and_payload_hash() {
        let cache_dir = PathBuf::from("C:\\cache\\codex-quota");
        let path = embedded_sidecar_cache_path(&cache_dir, b"demo-sidecar");

        assert!(path.starts_with(cache_dir.join("sidecar")));
        assert!(path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("expected file name")
            .starts_with(&format!("codex_quota_checker_sidecar-{}-", env!("CARGO_PKG_VERSION"))));
        assert_eq!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("exe")
        );
    }

    #[test]
    fn ensure_embedded_sidecar_writes_payload_to_cache_dir() {
        let cache_dir = tempfile::tempdir().expect("expected temp dir");
        let sidecar_path = ensure_embedded_sidecar_file(cache_dir.path(), b"fake-sidecar")
            .expect("expected sidecar write");

        assert!(sidecar_path.is_file());
        assert_eq!(
            fs::read(&sidecar_path).expect("expected sidecar bytes"),
            b"fake-sidecar"
        );
    }

    #[test]
    fn download_selected_accounts_sync_downloads_files_into_backup_dir() {
        let listener =
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).expect("expected local test listener");
        let address = listener.local_addr().expect("expected local addr");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("expected incoming connection");
            let mut request_buffer = [0_u8; 1024];
            let _ = stream.read(&mut request_buffer);
            let body = "{\"type\":\"codex\"}";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("expected response write");
        });

        let backup_dir = tempfile::tempdir().expect("expected temp dir");
        let mut on_progress =
            |_completed: usize, _total: usize, _current_label: &str| Ok::<(), String>(());
        let downloaded = download_selected_accounts_sync_with_progress(
            RuntimeConfig {
                cpa_base_url: format!("http://{}", address),
                management_key: String::new(),
                backup_path: backup_dir.path().to_string_lossy().to_string(),
                query_concurrency: 6,
                priority_plan_order: Vec::new(),
            },
            vec![String::from("codex-a.json")],
            &mut on_progress,
        )
        .expect("expected download success");

        server.join().expect("expected server join");
        assert_eq!(
            downloaded
                .first()
                .map(|item: &DownloadedAccountConfig| item.name.as_str()),
            Some("codex-a.json")
        );
        assert!(backup_dir.path().join("codex-a.json").is_file());
    }

    #[test]
    fn download_selected_accounts_sync_reports_each_completed_file() {
        let listener =
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).expect("expected local test listener");
        let address = listener.local_addr().expect("expected local addr");
        let server = thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().expect("expected incoming connection");
                let mut request_buffer = [0_u8; 1024];
                let _ = stream.read(&mut request_buffer);
                let body = "{\"type\":\"codex\"}";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("expected response write");
            }
        });

        let backup_dir = tempfile::tempdir().expect("expected temp dir");
        let mut progress_steps = Vec::new();
        let mut on_progress = |completed: usize, total: usize, current_label: &str| {
            // 备份全量时必须按文件逐步推进，不能只在最后一次跳满。
            progress_steps.push((completed, total, current_label.to_string()));
            Ok::<(), String>(())
        };
        let downloaded = download_selected_accounts_sync_with_progress(
            RuntimeConfig {
                cpa_base_url: format!("http://{}", address),
                management_key: String::new(),
                backup_path: backup_dir.path().to_string_lossy().to_string(),
                query_concurrency: 2,
                priority_plan_order: Vec::new(),
            },
            vec![
                String::from("codex-a.json"),
                String::from("codex-b.json"),
                String::from("codex-c.json"),
            ],
            &mut on_progress,
        )
        .expect("expected download success");

        server.join().expect("expected server join");
        assert_eq!(downloaded.len(), 3);
        assert_eq!(progress_steps.len(), 3);
        assert_eq!(progress_steps[0].0, 1);
        assert_eq!(progress_steps[1].0, 2);
        assert_eq!(progress_steps[2].0, 3);
        assert!(progress_steps.iter().all(|(_, total, _)| *total == 3));
        let mut completed_names = progress_steps
            .into_iter()
            .map(|(_, _, label)| label)
            .collect::<Vec<_>>();
        completed_names.sort();
        assert_eq!(
            completed_names,
            vec![
                String::from("codex-a.json"),
                String::from("codex-b.json"),
                String::from("codex-c.json"),
            ]
        );
    }

    #[test]
    fn sync_account_priorities_sync_calls_management_patch_route() {
        let listener =
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).expect("expected local test listener");
        let address = listener.local_addr().expect("expected local addr");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("expected request");
            let mut request_buffer = [0_u8; 2048];
            let size = stream
                .read(&mut request_buffer)
                .expect("expected request bytes");
            let request_text = String::from_utf8_lossy(&request_buffer[..size]);
            // 先锁住现有 CPA PATCH 路由和 JSON 负载，避免命令接错接口。
            assert!(request_text.contains("PATCH /v0/management/auth-files/fields HTTP/1.1"));
            assert!(request_text.contains("\"name\":\"codex-demo@example.com-free.json\""));
            assert!(request_text.contains("\"priority\":99"));

            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}")
                .expect("expected response");
        });

        let mut on_progress =
            |_completed: usize, _total: usize, _current_label: &str| Ok::<(), String>(());
        sync_account_priorities_sync_with_progress(
            RuntimeConfig {
                cpa_base_url: format!("http://{}", address),
                management_key: String::from("secret"),
                backup_path: String::new(),
                query_concurrency: 6,
                priority_plan_order: Vec::new(),
            },
            vec![PrioritySyncChange {
                name: String::from("codex-demo@example.com-free.json"),
                priority: 99,
            }],
            &mut on_progress,
        )
        .expect("expected sync success");

        server.join().expect("expected server join");
    }
}
