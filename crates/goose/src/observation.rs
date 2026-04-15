use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const INTERNAL_SEQUENCE_START: u64 = 1_000_000_000;

#[derive(Debug, Clone, Default)]
pub struct TraceMetadata {
    pub session_id: Option<String>,
    pub extension_name: Option<String>,
    pub transport_kind: Option<String>,
    pub endpoint: Option<String>,
    pub cwd: Option<String>,
}

struct ObservationTower {
    host: String,
    port: u16,
    path: String,
    host_header: String,
    process_id: String,
    child_pid: u32,
    default_cwd: String,
    sequence: AtomicU64,
}

impl ObservationTower {
    fn from_env() -> Option<Self> {
        let raw_url = std::env::var("GOOSE_OBSERVATION_TOWER_URL").ok()?;
        let raw_url = raw_url.trim();
        let without_scheme = raw_url.strip_prefix("http://")?;
        let without_scheme = without_scheme.trim_end_matches('/');
        let (host_port, base_path) = match without_scheme.split_once('/') {
            Some((host_port, path)) => (host_port, format!("/{}", path.trim_matches('/'))),
            None => (without_scheme, String::new()),
        };
        let (host, port) = match host_port.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), port.parse().ok()?),
            None => (host_port.to_string(), 80),
        };
        let path = if base_path.is_empty() {
            "/api/events".to_string()
        } else {
            format!("{base_path}/api/events")
        };
        let host_header = if port == 80 {
            host.clone()
        } else {
            format!("{host}:{port}")
        };
        let child_pid = std::process::id();
        let default_cwd = std::env::current_dir()
            .ok()
            .map(|path| path.display().to_string())
            .unwrap_or_default();

        Some(Self {
            host,
            port,
            path,
            host_header,
            process_id: format!("goose-serve-{child_pid}"),
            child_pid,
            default_cwd,
            sequence: AtomicU64::new(INTERNAL_SEQUENCE_START),
        })
    }

    fn global() -> Option<&'static Self> {
        static OBSERVATION_TOWER: OnceCell<Option<ObservationTower>> = OnceCell::new();
        OBSERVATION_TOWER.get_or_init(Self::from_env).as_ref()
    }

    fn publish_jsonrpc(
        &self,
        direction: &str,
        stream: &str,
        json_value: Value,
        metadata: &TraceMetadata,
    ) {
        let Ok(text) = serde_json::to_string(&json_value) else {
            return;
        };

        let payload = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "timestamp": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs_f64())
                .unwrap_or_default(),
            "sequence": self.sequence.fetch_add(1, Ordering::Relaxed),
            "processId": self.process_id,
            "childPid": self.child_pid,
            "cwd": metadata.cwd.clone().unwrap_or_else(|| self.default_cwd.clone()),
            "direction": direction,
            "stream": stream,
            "size": text.len(),
            "text": text,
            "json": json_value,
            "protocol": "mcp",
            "sessionId": metadata.session_id,
            "extensionName": metadata.extension_name,
            "transportKind": metadata.transport_kind,
            "endpoint": metadata.endpoint,
        });

        let Ok(body) = serde_json::to_vec(&payload) else {
            return;
        };

        let Ok(mut stream_socket) = std::net::TcpStream::connect((&*self.host, self.port)) else {
            return;
        };

        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.path,
            self.host_header,
            body.len(),
        );

        if stream_socket.write_all(request.as_bytes()).is_err() {
            return;
        }
        if stream_socket.write_all(&body).is_err() {
            return;
        }
        let _ = stream_socket.flush();
    }
}

pub fn publish_jsonrpc_trace(
    direction: &str,
    stream: &str,
    json_value: Value,
    metadata: &TraceMetadata,
) {
    if let Some(tower) = ObservationTower::global() {
        tower.publish_jsonrpc(direction, stream, json_value, metadata);
    }
}
