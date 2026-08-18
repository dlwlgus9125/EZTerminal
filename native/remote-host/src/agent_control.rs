use std::env;
use std::io::{self, Read};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const DESCRIPTOR_ENV: &str = "EZTERMINAL_AGENT_CONTROL_DESCRIPTOR";
const MAX_STDIN_BYTES: usize = 32 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

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
    let descriptor_text = env::var(DESCRIPTOR_ENV)
        .context("this shell has no EZTerminal Agent collaboration capability")?;
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
        Some("list") if args.len() == 1 => Ok(RequestSpec {
            path: "/v1/list",
            body: json!({}),
        }),
        Some("read") => parse_read(&args[1..]),
        Some("prompt") => parse_prompt(&args[1..]),
        Some("wait") => parse_wait(&args[1..]),
        Some("merge") => parse_merge(&args[1..]),
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
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_STDIN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > MAX_STDIN_BYTES {
        bail!("stdin must contain 1..32768 bytes");
    }
    let text = String::from_utf8(bytes).context("stdin must be UTF-8")?;
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
    "usage: ezterminal-agent list | read <id|alias> [--lines N] | prompt <id|alias> --stdin [--when-ready] [--wait] | wait <id|alias> --until <state> [--after stateSeq] | merge request --target <local-branch> [--wait] | merge wait <request-id>"
}
