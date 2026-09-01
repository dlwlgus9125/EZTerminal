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
        Some("map") => parse_map(&args[1..]),
        Some("merge") => parse_merge(&args[1..]),
        Some("team") => parse_team(&args[1..]),
        _ => bail!(usage()),
    }
}

fn parse_team(args: &[String]) -> Result<RequestSpec> {
    let (run_id, expected_revision) = parse_team_plan_arguments(args)?;
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_STDIN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > MAX_STDIN_BYTES {
        bail!("stdin must contain 1..32768 bytes");
    }
    let proposal: Value =
        serde_json::from_slice(&bytes).context("stdin must contain one JSON plan object")?;
    if !proposal.is_object() {
        bail!("stdin must contain one JSON plan object");
    }
    Ok(RequestSpec {
        path: "/v1/team/plan",
        body: json!({
            "runId": run_id,
            "expectedRevision": expected_revision,
            "proposal": proposal,
        }),
    })
}

fn parse_team_plan_arguments(args: &[String]) -> Result<(String, u64)> {
    if args.first().map(String::as_str) != Some("plan")
        || args.get(1).map(String::as_str) != Some("submit")
    {
        bail!(usage());
    }
    let run_id = args
        .get(2)
        .filter(|value| !value.starts_with('-'))
        .context(usage())?;
    let parts: Vec<&str> = run_id.split('-').collect();
    if parts.len() != 5
        || [8, 4, 4, 4, 12]
            .iter()
            .enumerate()
            .any(|(index, length)| parts[index].len() != *length)
        || !parts
            .iter()
            .all(|part| part.chars().all(|character| character.is_ascii_hexdigit()))
    {
        bail!("run id must be a UUID");
    }
    let mut expected_revision: Option<u64> = None;
    let mut stdin = false;
    let mut index = 3;
    while index < args.len() {
        match args[index].as_str() {
            "--revision" if expected_revision.is_none() => {
                index += 1;
                let value: u64 = args
                    .get(index)
                    .context("--revision requires a positive integer")?
                    .parse()?;
                if value == 0 {
                    bail!("--revision requires a positive integer");
                }
                expected_revision = Some(value);
            }
            "--stdin" if !stdin => stdin = true,
            _ => bail!(usage()),
        }
        index += 1;
    }
    if !stdin {
        bail!("the Team plan is accepted only with --stdin");
    }
    Ok((
        run_id.clone(),
        expected_revision.context("--revision is required")?,
    ))
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
            Ok(RequestSpec {
                path: "/v1/map/check",
                body: json!({ "mapId": map_id, "quality": quality }),
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
    "usage: ezterminal-agent list | read <id|alias> [--lines N] | prompt <id|alias> --stdin [--when-ready] [--wait] | wait <id|alias> --until <state> [--after stateSeq] | map guide <architecture|workflow|sequence|dataflow|lifecycle> | map check [map-id] [--quality draft|production] | map job <job-id> <phase> | team plan submit <run-id> --revision N --stdin | merge request --target <local-branch> [--wait] | merge wait <request-id>"
}

#[cfg(test)]
mod tests {
    use super::{parse_args, parse_team_plan_arguments};

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
    fn rejects_unknown_map_types_and_non_portable_ids() {
        assert!(parse_args(&args(&["map", "guide", "html"])).is_err());
        assert!(parse_args(&args(&["map", "check", "../runtime"])).is_err());
    }

    #[test]
    fn validates_team_plan_submission_arguments_without_reading_stdin() {
        let parsed = parse_team_plan_arguments(&args(&[
            "plan",
            "submit",
            "123e4567-e89b-12d3-a456-426614174000",
            "--revision",
            "7",
            "--stdin",
        ]))
        .expect("team plan arguments");
        assert_eq!(parsed.0, "123e4567-e89b-12d3-a456-426614174000");
        assert_eq!(parsed.1, 7);
        assert!(
            parse_team_plan_arguments(&args(&[
                "plan",
                "submit",
                "not-a-run",
                "--revision",
                "1",
                "--stdin",
            ]))
            .is_err()
        );
        assert!(
            parse_team_plan_arguments(&args(&[
                "plan",
                "submit",
                "123e4567-e89b-12d3-a456-426614174000",
                "--revision",
                "1",
            ]))
            .is_err()
        );
    }
}
