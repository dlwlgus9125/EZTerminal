use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

use crate::protocol::RemoteDisplay;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum AgentCommand {
    ProbeDisplays,
    Stop,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum AgentResponse {
    Ready { displays: Vec<RemoteDisplay> },
    Displays { displays: Vec<RemoteDisplay> },
    Stopped,
    Error { code: &'static str },
}

/// Session-agent stdio is the development harness for the eventual SID-bound
/// named-pipe channel. It already keeps the message surface closed and bounded,
/// so tests can exercise process lifecycle without granting arbitrary commands.
pub fn run(_args: &[String]) -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    write_response(
        &mut stdout,
        &AgentResponse::Ready {
            displays: displays(),
        },
    )?;

    for line in stdin.lock().lines() {
        let line = line.context("reading agent command")?;
        if line.len() > crate::protocol::MAX_CONTROL_BYTES {
            write_response(
                &mut stdout,
                &AgentResponse::Error {
                    code: "message-too-large",
                },
            )?;
            break;
        }
        let command = match serde_json::from_str::<AgentCommand>(&line) {
            Ok(command) => command,
            Err(_) => {
                write_response(
                    &mut stdout,
                    &AgentResponse::Error {
                        code: "invalid-message",
                    },
                )?;
                continue;
            }
        };
        match command {
            AgentCommand::ProbeDisplays => write_response(
                &mut stdout,
                &AgentResponse::Displays {
                    displays: displays(),
                },
            )?,
            AgentCommand::Stop => {
                write_response(&mut stdout, &AgentResponse::Stopped)?;
                break;
            }
        }
    }
    Ok(())
}

fn displays() -> Vec<RemoteDisplay> {
    let width = unsafe { GetSystemMetrics(SM_CXSCREEN) }.max(0) as u32;
    let height = unsafe { GetSystemMetrics(SM_CYSCREEN) }.max(0) as u32;
    if width == 0 || height == 0 {
        Vec::new()
    } else {
        vec![RemoteDisplay {
            id: "primary".into(),
            name: "Primary display".into(),
            width,
            height,
            rotation_degrees: 0,
            primary: true,
        }]
    }
}

fn write_response(output: &mut impl Write, response: &AgentResponse) -> Result<()> {
    serde_json::to_writer(&mut *output, response)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
