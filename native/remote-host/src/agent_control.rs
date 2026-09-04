use std::env;
use std::io::{self, Read};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use uuid::Uuid;

const DESCRIPTOR_ENV: &str = "EZTERMINAL_AGENT_CONTROL_DESCRIPTOR";
const MAX_STDIN_BYTES: usize = 32 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_PAGE_SIZE: u64 = 500;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
struct Descriptor {
    version: u8,
    origin: String,
    token: String,
}

struct RequestSpec {
    path: &'static str,
    body: Value,
}

pub fn run(args: &[String]) -> Result<()> {
    if matches!(
        args.first().map(String::as_str),
        Some("help" | "--help" | "-h")
    ) {
        println!("{}", usage());
        return Ok(());
    }
    let descriptor_text = env::var(DESCRIPTOR_ENV)
        .context("this shell has no EZTerminal local control capability")?;
    let descriptor: Descriptor = serde_json::from_str(&descriptor_text)
        .context("the EZTerminal Agent capability descriptor is invalid")?;
    if descriptor.version != 1 || descriptor.token.len() < 32 {
        bail!("the EZTerminal Agent capability descriptor is unsupported");
    }
    let request = parse_args(args)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    let (status, body) = runtime.block_on(post_json(&descriptor, request))?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    if !(200..300).contains(&status) || body.get("ok") != Some(&Value::Bool(true)) {
        bail!("agent-control request failed with HTTP {status}");
    }
    Ok(())
}

fn parse_args(args: &[String]) -> Result<RequestSpec> {
    match args.first().map(String::as_str) {
        Some("status") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/daemon/status",
            body: json!({}),
        }),
        Some("snapshot") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/daemon/snapshot",
            body: json!({}),
        }),
        Some("sessions") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/daemon/sessions",
            body: json!({}),
        }),
        Some("agents") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/daemon/agents",
            body: json!({}),
        }),
        Some("schedules") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/daemon/schedules",
            body: json!({}),
        }),
        Some("send") => parse_daemon_send(&args[1..]),
        Some("cancel") => parse_daemon_cancel(&args[1..]),
        Some("agent") => parse_daemon_agent(&args[1..]),
        Some("schedule") => parse_daemon_schedule(&args[1..]),
        Some("heartbeat") => parse_daemon_heartbeat(&args[1..]),
        Some("list") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/list",
            body: json!({}),
        }),
        Some("read") => parse_read(&args[1..]),
        Some("prompt") => parse_prompt(&args[1..]),
        Some("wait") => parse_wait(&args[1..]),
        Some("map") => parse_map(&args[1..]),
        Some("merge") => parse_merge(&args[1..]),
        Some("workers") => parse_workers(&args[1..]),
        Some("worker") => parse_worker(&args[1..]),
        _ => bail!(usage()),
    }
}

fn request_id() -> String {
    Uuid::new_v4().to_string()
}

fn daemon_target(value: &str) -> Result<&str> {
    let target = value.trim();
    let traversal_like = target.split(['/', '\\']).any(|segment| segment == "..");
    if target.is_empty()
        || target.starts_with('-')
        || target.len() > 1024
        || target.chars().any(char::is_control)
        || traversal_like
    {
        bail!(
            "target must contain 1..1024 UTF-8 bytes without flags, control characters, or traversal segments"
        );
    }
    Ok(target)
}

fn read_stdin_json_object(label: &str) -> Result<serde_json::Map<String, Value>> {
    let value: Value = serde_json::from_slice(&read_stdin_bytes()?)
        .with_context(|| format!("stdin must contain one JSON {label} object"))?;
    value
        .as_object()
        .cloned()
        .with_context(|| format!("stdin must contain one JSON {label} object"))
}

fn reject_reserved_fields(body: &serde_json::Map<String, Value>, fields: &[&str]) -> Result<()> {
    if let Some(field) = fields.iter().find(|field| body.contains_key(**field)) {
        bail!("JSON input cannot set reserved field {field}");
    }
    Ok(())
}

fn build_targeted_json_request(
    path: &'static str,
    target: &str,
    value: Value,
) -> Result<RequestSpec> {
    let target = daemon_target(target)?;
    let mut body = value
        .as_object()
        .cloned()
        .context("stdin must contain one JSON configuration object")?;
    reject_reserved_fields(&body, &["target", "requestId"])?;
    body.insert("target".to_owned(), Value::String(target.to_owned()));
    body.insert("requestId".to_owned(), Value::String(request_id()));
    Ok(RequestSpec {
        path,
        body: Value::Object(body),
    })
}

fn parse_daemon_agent(args: &[String]) -> Result<RequestSpec> {
    match args.first().map(String::as_str) {
        Some("read") => parse_daemon_agent_read(&args[1..]),
        Some("send") => parse_daemon_send(&args[1..]),
        Some("interrupt-and-send") => parse_daemon_prompt_action(
            &args[1..],
            "/v1/daemon/agents/interrupt-and-send",
            "interrupt-and-send",
        ),
        Some(action @ ("interrupt" | "cancel" | "archive" | "detach")) if args.len() == 2 => {
            let target = daemon_target(&args[1])?;
            let path = match action {
                "interrupt" => "/v1/daemon/agents/interrupt",
                "cancel" => "/v1/daemon/agents/cancel",
                "archive" => "/v1/daemon/agents/archive",
                "detach" => "/v1/daemon/agents/detach",
                _ => unreachable!(),
            };
            Ok(RequestSpec {
                path,
                body: json!({ "target": target, "requestId": request_id() }),
            })
        }
        Some("settings") if args.len() == 3 && args[2] == "--stdin" => {
            let target = daemon_target(&args[1])?;
            let body = Value::Object(read_stdin_json_object("Agent settings")?);
            build_targeted_json_request("/v1/daemon/agents/settings", target, body)
        }
        _ => bail!(usage()),
    }
}

fn parse_daemon_agent_read(args: &[String]) -> Result<RequestSpec> {
    let target = daemon_target(args.first().context(usage())?)?;
    let mut after_sequence: Option<u64> = None;
    let mut limit: Option<u64> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--after" if after_sequence.is_none() => {
                index += 1;
                let value = args.get(index).context("--after requires a sequence")?;
                let parsed: u64 = value
                    .parse()
                    .context("--after requires a non-negative integer")?;
                if parsed > MAX_SAFE_JS_INTEGER {
                    bail!("--after must be a JavaScript-safe integer");
                }
                after_sequence = Some(parsed);
            }
            "--limit" if limit.is_none() => {
                index += 1;
                let parsed: u64 = args
                    .get(index)
                    .context("--limit requires a number")?
                    .parse()
                    .context("--limit requires a positive integer")?;
                if !(1..=MAX_TRANSCRIPT_PAGE_SIZE).contains(&parsed) {
                    bail!("--limit must be between 1 and {MAX_TRANSCRIPT_PAGE_SIZE}");
                }
                limit = Some(parsed);
            }
            _ => bail!(usage()),
        }
        index += 1;
    }
    let mut body = serde_json::Map::new();
    body.insert("target".to_owned(), Value::String(target.to_owned()));
    if let Some(value) = after_sequence {
        body.insert("afterSequence".to_owned(), Value::Number(value.into()));
    }
    if let Some(value) = limit {
        body.insert("limit".to_owned(), Value::Number(value.into()));
    }
    Ok(RequestSpec {
        path: "/v1/daemon/agents/read",
        body: Value::Object(body),
    })
}

fn parse_daemon_prompt_action(
    args: &[String],
    path: &'static str,
    action: &str,
) -> Result<RequestSpec> {
    let target = daemon_target(args.first().context(usage())?)?;
    if args.len() != 2 || args[1] != "--stdin" {
        bail!("{action} prompt text is accepted only with --stdin");
    }
    Ok(RequestSpec {
        path,
        body: json!({ "target": target, "prompt": read_stdin_text()?, "requestId": request_id() }),
    })
}

fn parse_daemon_send(args: &[String]) -> Result<RequestSpec> {
    parse_daemon_prompt_action(args, "/v1/daemon/agents/send", "send")
}

fn parse_daemon_cancel(args: &[String]) -> Result<RequestSpec> {
    if args.len() != 1 {
        bail!(usage());
    }
    let target = daemon_target(&args[0])?;
    Ok(RequestSpec {
        path: "/v1/daemon/agents/cancel",
        body: json!({ "target": target, "requestId": request_id() }),
    })
}

fn parse_daemon_schedule(args: &[String]) -> Result<RequestSpec> {
    match args.first().map(String::as_str) {
        Some("create") if args.len() == 2 && args[1] == "--stdin" => {
            let body = Value::Object(read_stdin_json_object("Schedule create")?);
            build_daemon_schedule_create(body)
        }
        Some("update") if args.len() == 3 && args[2] == "--stdin" => {
            let target = daemon_target(&args[1])?;
            let body = Value::Object(read_stdin_json_object("Schedule update")?);
            build_targeted_json_request("/v1/daemon/schedules/update", target, body)
        }
        Some(action @ ("delete" | "run")) if args.len() == 2 => {
            let target = daemon_target(&args[1])?;
            Ok(RequestSpec {
                path: if action == "delete" {
                    "/v1/daemon/schedules/delete"
                } else {
                    "/v1/daemon/schedules/run"
                },
                body: json!({ "target": target, "requestId": request_id() }),
            })
        }
        _ => bail!(usage()),
    }
}

fn build_daemon_schedule_create(value: Value) -> Result<RequestSpec> {
    let mut body = value
        .as_object()
        .cloned()
        .context("stdin must contain one JSON Schedule create object")?;
    reject_reserved_fields(&body, &["target", "requestId"])?;
    if !body.contains_key("scheduleId") {
        body.insert(
            "scheduleId".to_owned(),
            Value::String(format!("schedule-{}", Uuid::new_v4())),
        );
    }
    body.insert("requestId".to_owned(), Value::String(request_id()));
    Ok(RequestSpec {
        path: "/v1/daemon/schedules/create",
        body: Value::Object(body),
    })
}

fn parse_daemon_heartbeat(args: &[String]) -> Result<RequestSpec> {
    match args.first().map(String::as_str) {
        Some("configure") if args.len() == 3 && args[2] == "--stdin" => {
            let target = daemon_target(&args[1])?;
            let body = Value::Object(read_stdin_json_object("heartbeat configuration")?);
            build_targeted_json_request("/v1/daemon/heartbeats/configure", target, body)
        }
        Some("trigger") if args.len() == 2 => {
            let target = daemon_target(&args[1])?;
            Ok(RequestSpec {
                path: "/v1/daemon/heartbeats/trigger",
                body: json!({ "target": target, "requestId": request_id() }),
            })
        }
        _ => bail!(usage()),
    }
}

fn read_stdin_bytes() -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_STDIN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > MAX_STDIN_BYTES {
        bail!("stdin must contain 1..32768 bytes");
    }
    Ok(bytes)
}

fn read_stdin_text() -> Result<String> {
    String::from_utf8(read_stdin_bytes()?).context("stdin must be UTF-8")
}

fn parse_workers(args: &[String]) -> Result<RequestSpec> {
    match args.first().map(String::as_str) {
        Some("profiles") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/workers/profiles",
            body: json!({}),
        }),
        Some("list") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/workers",
            body: json!({}),
        }),
        Some("create") if args.len() == 2 && args[1] == "--stdin" => {
            let body: Value = serde_json::from_slice(&read_stdin_bytes()?)
                .context("stdin must contain one JSON worker request")?;
            if !body.is_object() {
                bail!("stdin must contain one JSON worker request");
            }
            Ok(RequestSpec {
                path: "/v1/workers/create",
                body,
            })
        }
        Some("read") if args.len() == 2 => Ok(RequestSpec {
            path: "/v1/workers/read",
            body: json!({ "taskId": args[1] }),
        }),
        Some("prompt") if args.len() == 3 && args[2] == "--stdin" => Ok(RequestSpec {
            path: "/v1/workers/prompt",
            body: json!({ "taskId": args[1], "text": read_stdin_text()? }),
        }),
        Some("cancel") if args.len() == 2 => Ok(RequestSpec {
            path: "/v1/workers/cancel",
            body: json!({ "taskId": args[1] }),
        }),
        Some("archive") if args.len() == 2 => Ok(RequestSpec {
            path: "/v1/workers/archive",
            body: json!({ "taskId": args[1] }),
        }),
        Some("merge") => {
            let task_id = args
                .get(1)
                .filter(|value| !value.starts_with('-'))
                .context(usage())?;
            let mut target: Option<String> = None;
            let mut index = 2;
            while index < args.len() {
                match args[index].as_str() {
                    "--target" if target.is_none() => {
                        index += 1;
                        target = Some(
                            args.get(index)
                                .context("--target requires a local branch")?
                                .clone(),
                        );
                    }
                    _ => bail!(usage()),
                }
                index += 1;
            }
            Ok(RequestSpec {
                path: "/v1/workers/merge",
                body: json!({ "taskId": task_id, "targetBranch": target.context("--target is required")? }),
            })
        }
        Some("complete") if args.len() == 2 => Ok(RequestSpec {
            path: "/v1/workers/complete",
            body: json!({ "runId": args[1] }),
        }),
        _ => bail!(usage()),
    }
}

fn parse_worker(args: &[String]) -> Result<RequestSpec> {
    if !args.iter().any(|value| value == "--stdin") {
        bail!("worker summary is accepted only with --stdin");
    }
    build_worker_report(args, read_stdin_text()?)
}

fn build_worker_report(args: &[String], summary: String) -> Result<RequestSpec> {
    if args.first().map(String::as_str) != Some("report") {
        bail!(usage());
    }
    let task_id = args
        .get(1)
        .filter(|value| !value.starts_with('-'))
        .context(usage())?;
    let mut outcome: Option<String> = None;
    let mut source_head: Option<String> = None;
    let mut verifies_task: Option<String> = None;
    let mut verifies_head: Option<String> = None;
    let mut stdin = false;
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--outcome" if outcome.is_none() => {
                index += 1;
                let value = args
                    .get(index)
                    .context("--outcome requires succeeded or failed")?;
                if value != "succeeded" && value != "failed" {
                    bail!("--outcome requires succeeded or failed");
                }
                outcome = Some(value.clone());
            }
            "--source-head" if source_head.is_none() => {
                index += 1;
                source_head = Some(
                    args.get(index)
                        .context("--source-head requires a Git object id")?
                        .clone(),
                );
            }
            "--verifies-task" if verifies_task.is_none() => {
                index += 1;
                verifies_task = Some(
                    args.get(index)
                        .context("--verifies-task requires a task id")?
                        .clone(),
                );
            }
            "--verifies-head" if verifies_head.is_none() => {
                index += 1;
                verifies_head = Some(
                    args.get(index)
                        .context("--verifies-head requires a Git object id")?
                        .clone(),
                );
            }
            "--stdin" if !stdin => stdin = true,
            _ => bail!(usage()),
        }
        index += 1;
    }
    if !stdin {
        bail!("worker summary is accepted only with --stdin");
    }
    for head in [&source_head, &verifies_head].into_iter().flatten() {
        if !(40..=64).contains(&head.len())
            || !head.chars().all(|character| character.is_ascii_hexdigit())
        {
            bail!("Git object ids must contain 40..64 hexadecimal characters");
        }
    }
    let mut body = serde_json::Map::new();
    body.insert("taskId".to_owned(), Value::String(task_id.clone()));
    body.insert(
        "outcome".to_owned(),
        Value::String(outcome.context("--outcome is required")?),
    );
    body.insert("summary".to_owned(), Value::String(summary));
    if let Some(value) = source_head {
        body.insert("sourceHead".to_owned(), Value::String(value));
    }
    if let Some(value) = verifies_task {
        body.insert("verifiesTaskId".to_owned(), Value::String(value));
    }
    if let Some(value) = verifies_head {
        body.insert("verifiesHead".to_owned(), Value::String(value));
    }
    Ok(RequestSpec {
        path: "/v1/worker/report",
        body: Value::Object(body),
    })
}

fn parse_map(args: &[String]) -> Result<RequestSpec> {
    match args.first().map(String::as_str) {
        Some("guide") if args.len() == 2 => {
            let map_type = args[1].as_str();
            if ![
                "architecture",
                "workflow",
                "sequence",
                "dataflow",
                "lifecycle",
            ]
            .contains(&map_type)
            {
                bail!("unknown Project Map type: {map_type}");
            }
            Ok(RequestSpec {
                path: "/v1/map/guide",
                body: json!({ "type": map_type }),
            })
        }
        Some("check") => {
            let mut map_id: Option<&String> = None;
            let mut quality = "production";
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--quality" => {
                        index += 1;
                        quality = args
                            .get(index)
                            .context("--quality requires draft or production")?;
                        if quality != "draft" && quality != "production" {
                            bail!("--quality must be draft or production");
                        }
                    }
                    value if !value.starts_with('-') && map_id.is_none() => {
                        map_id = args.get(index)
                    }
                    _ => bail!(usage()),
                }
                index += 1;
            }
            if let Some(value) = map_id
                && (value.is_empty()
                    || value.len() > 64
                    || !value.chars().enumerate().all(|(index, character)| {
                        (index == 0 && character.is_ascii_lowercase())
                            || (index > 0
                                && (character.is_ascii_lowercase()
                                    || character.is_ascii_digit()
                                    || character == '-'))
                    }))
            {
                bail!("map id must match [a-z][a-z0-9-]{{0,63}}");
            }
            let mut body = serde_json::Map::new();
            body.insert("quality".to_owned(), Value::String(quality.to_owned()));
            if let Some(value) = map_id {
                body.insert("mapId".to_owned(), Value::String(value.clone()));
            }
            Ok(RequestSpec {
                path: "/v1/map/check",
                body: Value::Object(body),
            })
        }
        Some("job") if args.len() == 3 => {
            let job_id = &args[1];
            let phase = args[2].as_str();
            if job_id.len() < 20
                || job_id.len() > 64
                || !job_id
                    .chars()
                    .all(|character| character.is_ascii_hexdigit() || character == '-')
            {
                bail!("job id is invalid");
            }
            if ![
                "analyzing",
                "authoring",
                "validating-draft",
                "validating-production",
                "awaiting-review",
                "completed",
                "failed",
                "canceled",
            ]
            .contains(&phase)
            {
                bail!("unknown Project Map job phase: {phase}");
            }
            Ok(RequestSpec {
                path: "/v1/map/job",
                body: json!({ "jobId": job_id, "phase": phase }),
            })
        }
        _ => bail!(usage()),
    }
}

fn parse_read(args: &[String]) -> Result<RequestSpec> {
    let target = args
        .first()
        .filter(|value| !value.starts_with('-'))
        .context(usage())?;
    let mut lines = 80_u64;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--lines" => {
                index += 1;
                lines = args
                    .get(index)
                    .context("--lines requires a number")?
                    .parse()?;
                if !(1..=200).contains(&lines) {
                    bail!("--lines must be between 1 and 200");
                }
            }
            _ => bail!(usage()),
        }
        index += 1;
    }
    Ok(RequestSpec {
        path: "/v1/read",
        body: json!({ "target": target, "lines": lines }),
    })
}

fn parse_prompt(args: &[String]) -> Result<RequestSpec> {
    let target = args
        .first()
        .filter(|value| !value.starts_with('-'))
        .context(usage())?;
    let mut stdin = false;
    let mut when_ready = false;
    let mut wait = false;
    for flag in &args[1..] {
        match flag.as_str() {
            "--stdin" => stdin = true,
            "--when-ready" => when_ready = true,
            "--wait" => wait = true,
            _ => bail!(usage()),
        }
    }
    if !stdin {
        bail!("prompt text is accepted only with --stdin");
    }
    let text = read_stdin_text()?;
    Ok(RequestSpec {
        path: "/v1/prompt",
        body: json!({ "target": target, "text": text, "whenReady": when_ready, "wait": wait }),
    })
}

fn parse_wait(args: &[String]) -> Result<RequestSpec> {
    let target = args
        .first()
        .filter(|value| !value.starts_with('-'))
        .context(usage())?;
    let mut until: Option<String> = None;
    let mut after: Option<u64> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--until" => {
                index += 1;
                until = Some(args.get(index).context("--until requires a state")?.clone());
            }
            "--after" => {
                index += 1;
                after = Some(
                    args.get(index)
                        .context("--after requires a state sequence")?
                        .parse()?,
                );
            }
            _ => bail!(usage()),
        }
        index += 1;
    }
    let state = until.context("--until is required")?;
    if ![
        "starting", "working", "blocked", "done", "idle", "error", "unknown",
    ]
    .contains(&state.as_str())
    {
        bail!("unknown Agent state: {state}");
    }
    Ok(RequestSpec {
        path: "/v1/wait",
        body: json!({ "target": target, "states": [state], "afterStateSeq": after }),
    })
}

fn parse_merge(args: &[String]) -> Result<RequestSpec> {
    match args.first().map(String::as_str) {
        Some("request") => {
            let mut target: Option<String> = None;
            let mut wait = false;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--target" => {
                        index += 1;
                        target = Some(
                            args.get(index)
                                .context("--target requires a local branch")?
                                .clone(),
                        );
                    }
                    "--wait" => wait = true,
                    _ => bail!(usage()),
                }
                index += 1;
            }
            Ok(RequestSpec {
                path: "/v1/merge/request",
                body: json!({ "targetBranch": target.context("--target is required")?, "wait": wait }),
            })
        }
        Some("wait") if args.len() == 2 => Ok(RequestSpec {
            path: "/v1/merge/wait",
            body: json!({ "requestId": args[1] }),
        }),
        _ => bail!(usage()),
    }
}

async fn post_json(descriptor: &Descriptor, request: RequestSpec) -> Result<(u16, Value)> {
    let authority = descriptor
        .origin
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(|| anyhow!("Agent control origin is not IPv4 loopback"))?;
    let port: u16 = authority
        .parse()
        .context("Agent control origin has an invalid port")?;
    let body = serde_json::to_vec(&request.body)?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let headers = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        request.path,
        port,
        descriptor.token,
        body.len(),
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await?;
    let mut response = Vec::new();
    stream
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .await?;
    if response.len() > MAX_RESPONSE_BYTES {
        bail!("Agent control response exceeded 2 MiB");
    }
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| anyhow!("Agent control returned malformed HTTP"))?;
    let head = std::str::from_utf8(&response[..split])?;
    let status: u16 = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .context("Agent control returned no HTTP status")?
        .parse()?;
    let value = serde_json::from_slice(&response[split + 4..])
        .context("Agent control returned invalid JSON")?;
    Ok((status, value))
}

fn usage() -> &'static str {
    "EZTerminal local control\n\
usage:\n\
  ezterminal status|snapshot|sessions|agents|schedules\n\
  ezterminal send <session-id|unique-title> --stdin\n\
  ezterminal cancel <session-id|unique-title>\n\
  ezterminal agent read <session-id|unique-title> [--after SEQUENCE] [--limit 1..500]\n\
  ezterminal agent send|interrupt-and-send <session-id|unique-title> --stdin\n\
  ezterminal agent interrupt|cancel|archive|detach <session-id|unique-title>\n\
  ezterminal agent settings <session-id|unique-title> --stdin\n\
  ezterminal schedule create --stdin\n\
  ezterminal schedule update <schedule-id|unique-name> --stdin\n\
  ezterminal schedule delete|run <schedule-id|unique-name>\n\
  ezterminal heartbeat configure <session-id|unique-title> --stdin\n\
  ezterminal heartbeat trigger <session-id|unique-title>\n\
\n\
JSON stdin is limited to 32 KiB. Complex commands reject reserved target/requestId fields.\n\
Schedule create accepts an optional scheduleId and generates one when omitted.\n\
\n\
Compatibility commands:\n\
  ezterminal-agent list\n\
  ezterminal-agent read <id|alias> [--lines N]\n\
  ezterminal-agent prompt <id|alias> --stdin [--when-ready] [--wait]\n\
  ezterminal-agent wait <id|alias> --until <state> [--after stateSeq]\n\
  ezterminal-agent workers profiles|list|create --stdin|read <task>|prompt <task> --stdin|cancel <task>|archive <task>|merge <task> --target <branch>|complete <run>\n\
  ezterminal-agent worker report <task> --outcome <succeeded|failed> --stdin [--source-head <oid>] [--verifies-task <task> --verifies-head <oid>]\n\
  ezterminal-agent map guide <architecture|workflow|sequence|dataflow|lifecycle>\n\
  ezterminal-agent map check [map-id] [--quality draft|production]\n\
  ezterminal-agent map job <job-id> <phase>\n\
  ezterminal-agent merge request --target <local-branch> [--wait]\n\
  ezterminal-agent merge wait <request-id>"
}

#[cfg(test)]
mod tests {
    use super::{
        build_daemon_schedule_create, build_targeted_json_request, build_worker_report, parse_args,
    };
    use serde_json::json;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_project_map_guide_and_check() {
        let guide = parse_args(&args(&["map", "guide", "sequence"])).expect("guide");
        assert_eq!(guide.path, "/v1/map/guide");
        assert_eq!(guide.body["type"], "sequence");

        let check = parse_args(&args(&["map", "check", "runtime-architecture"])).expect("check");
        assert_eq!(check.path, "/v1/map/check");
        assert_eq!(check.body["mapId"], "runtime-architecture");
    }

    #[test]
    fn parses_daemon_reads_and_safe_mutations() {
        assert_eq!(
            parse_args(&args(&["status"])).expect("status").path,
            "/v1/daemon/status"
        );
        assert_eq!(
            parse_args(&args(&["snapshot"])).expect("snapshot").path,
            "/v1/daemon/snapshot"
        );
        assert_eq!(
            parse_args(&args(&["sessions"])).expect("sessions").path,
            "/v1/daemon/sessions"
        );
        assert_eq!(
            parse_args(&args(&["agents"])).expect("agents").path,
            "/v1/daemon/agents"
        );
        assert_eq!(
            parse_args(&args(&["schedules"])).expect("schedules").path,
            "/v1/daemon/schedules"
        );

        let cancel = parse_args(&args(&["cancel", "agent-1"])).expect("cancel");
        assert_eq!(cancel.path, "/v1/daemon/agents/cancel");
        assert_eq!(cancel.body["target"], "agent-1");
        assert!(
            cancel.body["requestId"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );

        let schedule = parse_args(&args(&["schedule", "run", "morning"])).expect("schedule");
        assert_eq!(schedule.path, "/v1/daemon/schedules/run");
        assert_eq!(schedule.body["target"], "morning");

        let schedule_delete =
            parse_args(&args(&["schedule", "delete", "morning"])).expect("schedule delete");
        assert_eq!(schedule_delete.path, "/v1/daemon/schedules/delete");

        let heartbeat = parse_args(&args(&["heartbeat", "trigger", "agent-1"])).expect("heartbeat");
        assert_eq!(heartbeat.path, "/v1/daemon/heartbeats/trigger");
        assert_eq!(heartbeat.body["target"], "agent-1");

        assert!(parse_args(&args(&["cancel", "agent-1", "extra"])).is_err());
        assert!(parse_args(&args(&["schedule", "delete", "../"])).is_err());
        assert!(parse_args(&args(&["schedule", "delete", "-foreign"])).is_err());
    }

    #[test]
    fn parses_direct_agent_controls_and_bounded_transcript_reads() {
        let read = parse_args(&args(&[
            "agent", "read", "Builder", "--after", "12", "--limit", "250",
        ]))
        .expect("agent read");
        assert_eq!(read.path, "/v1/daemon/agents/read");
        assert_eq!(read.body["target"], "Builder");
        assert_eq!(read.body["afterSequence"], 12);
        assert_eq!(read.body["limit"], 250);

        for (action, path) in [
            ("interrupt", "/v1/daemon/agents/interrupt"),
            ("cancel", "/v1/daemon/agents/cancel"),
            ("archive", "/v1/daemon/agents/archive"),
            ("detach", "/v1/daemon/agents/detach"),
        ] {
            let request = parse_args(&args(&["agent", action, "agent-1"])).expect("Agent action");
            assert_eq!(request.path, path);
            assert_eq!(request.body["target"], "agent-1");
        }

        assert!(parse_args(&args(&["agent", "read", "agent-1", "--limit", "501"])).is_err());
        assert!(
            parse_args(&args(&[
                "agent",
                "read",
                "agent-1",
                "--after",
                "9007199254740992",
            ]))
            .is_err()
        );
    }

    #[test]
    fn builds_bounded_json_control_requests_without_reserved_field_override() {
        let settings = build_targeted_json_request(
            "/v1/daemon/agents/settings",
            "Builder",
            json!({ "model": "gpt-5.6", "permissionPreset": "plan" }),
        )
        .expect("settings");
        assert_eq!(settings.body["target"], "Builder");
        assert_eq!(settings.body["model"], "gpt-5.6");
        assert!(
            settings.body["requestId"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );

        assert!(
            build_targeted_json_request(
                "/v1/daemon/agents/settings",
                "Builder",
                json!({ "target": "Foreign", "model": "gpt-5.6" }),
            )
            .is_err()
        );
        assert!(
            build_targeted_json_request(
                "/v1/daemon/agents/settings",
                "Builder",
                json!(["not", "an", "object"]),
            )
            .is_err()
        );
    }

    #[test]
    fn generates_schedule_ids_without_overwriting_explicit_ids() {
        let generated = build_daemon_schedule_create(json!({
            "name": "Morning",
            "workspace": "Main",
            "providerId": "codex"
        }))
        .expect("generated schedule");
        assert!(
            generated.body["scheduleId"]
                .as_str()
                .is_some_and(|value| value.starts_with("schedule-"))
        );

        let explicit = build_daemon_schedule_create(json!({
            "scheduleId": "daily-review",
            "name": "Morning",
            "workspaceId": "workspace-1",
            "providerId": "codex"
        }))
        .expect("explicit schedule");
        assert_eq!(explicit.body["scheduleId"], "daily-review");
        assert!(
            build_daemon_schedule_create(json!({
                "requestId": "caller-controlled",
                "name": "Morning"
            }))
            .is_err()
        );
    }

    #[test]
    fn rejects_unknown_map_types_and_non_portable_ids() {
        assert!(parse_args(&args(&["map", "guide", "html"])).is_err());
        assert!(parse_args(&args(&["map", "check", "../runtime"])).is_err());
    }

    #[test]
    fn parses_lead_worker_control_routes() {
        let profiles = parse_args(&args(&["workers", "profiles"])).expect("profiles");
        assert_eq!(profiles.path, "/v1/workers/profiles");

        let list = parse_args(&args(&["workers", "list"])).expect("list");
        assert_eq!(list.path, "/v1/workers");

        let read = parse_args(&args(&["workers", "read", "task-1"])).expect("read");
        assert_eq!(read.path, "/v1/workers/read");
        assert_eq!(read.body["taskId"], "task-1");

        let merge =
            parse_args(&args(&["workers", "merge", "task-1", "--target", "main"])).expect("merge");
        assert_eq!(merge.path, "/v1/workers/merge");
        assert_eq!(merge.body["targetBranch"], "main");

        let complete = parse_args(&args(&["workers", "complete", "run-1"])).expect("complete");
        assert_eq!(complete.path, "/v1/workers/complete");
        assert!(parse_args(&args(&["workers", "merge", "task-1"])).is_err());
    }

    #[test]
    fn builds_structured_worker_reports_without_null_optional_fields() {
        let report = build_worker_report(
            &args(&[
                "report",
                "task-1",
                "--outcome",
                "succeeded",
                "--stdin",
                "--source-head",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ]),
            "bounded result".to_owned(),
        )
        .expect("report");
        assert_eq!(report.path, "/v1/worker/report");
        assert_eq!(report.body["summary"], "bounded result");
        assert_eq!(
            report.body["sourceHead"],
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(report.body.get("verifiesTaskId").is_none());
        assert!(report.body.get("verifiesHead").is_none());

        assert!(
            build_worker_report(
                &args(&[
                    "report",
                    "task-1",
                    "--outcome",
                    "succeeded",
                    "--stdin",
                    "--source-head",
                    "not-a-git-object",
                ]),
                "result".to_owned(),
            )
            .is_err()
        );
    }

    #[test]
    fn omits_the_optional_map_id_instead_of_sending_null() {
        let check = parse_args(&args(&["map", "check"])).expect("check");
        assert_eq!(check.body["quality"], "production");
        assert!(check.body.get("mapId").is_none());
    }
}
