use std::io::{BufRead, Write};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_READOBJECTS, DESKTOP_WRITEOBJECTS, OpenInputDesktop,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

use crate::broker::CapabilitySet;
use crate::capture::{DisplayCapture, enumerate_displays};
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

/// The installed service starts broker mode inside the active Windows session.
/// The no-argument stdio mode remains a closed development harness.
pub fn run(args: &[String]) -> Result<()> {
    if args.iter().any(|arg| arg == "--broker-pipe") {
        return run_broker_mode(args);
    }
    run_stdio_harness()
}

fn run_broker_mode(args: &[String]) -> Result<()> {
    let pipe_name = required_arg(args, "--broker-pipe")?;
    let remote_session_id = required_arg(args, "--remote-session-id")?
        .parse::<Uuid>()
        .context("parsing broker remote session id")?;
    let nonce = required_arg(args, "--nonce")?
        .parse::<Uuid>()
        .context("parsing broker nonce")?;
    let windows_session_id = required_arg(args, "--windows-session-id")?
        .parse::<u32>()
        .context("parsing broker Windows session id")?;
    let service_process_id = required_arg(args, "--service-pid")?
        .parse::<u32>()
        .context("parsing broker service process id")?;
    crate::local_broker::run_agent_channel(
        pipe_name,
        remote_session_id,
        nonce,
        windows_session_id,
        service_process_id,
        probe_capabilities(),
    )
}

fn run_stdio_harness() -> Result<()> {
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

fn required_arg<'a>(args: &'a [String], name: &str) -> Result<&'a str> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| anyhow::anyhow!("missing session-agent argument {name}"))?;
    args.get(index + 1)
        .map(String::as_str)
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| anyhow::anyhow!("invalid session-agent argument {name}"))
}

fn probe_capabilities() -> CapabilitySet {
    let capture = enumerate_displays()
        .and_then(|displays| {
            let display = displays
                .into_iter()
                .find(|display| display.primary)
                .ok_or_else(|| anyhow::anyhow!("primary display is unavailable"))?;
            let mut capture = DisplayCapture::new(display, 64, 64)?;
            let _ = capture.capture()?;
            Ok(())
        })
        .is_ok();
    let input_desktop = unsafe {
        OpenInputDesktop(
            Default::default(),
            false,
            DESKTOP_ACCESS_FLAGS(DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0),
        )
    };
    let input = match input_desktop {
        Ok(desktop) => {
            let _ = unsafe { CloseDesktop(desktop) };
            true
        }
        Err(_) => false,
    };
    CapabilitySet {
        capture,
        input,
        // Windows does not expose SendSAS to a normal desktop process. Never
        // advertise this privileged operation until an audited implementation exists.
        secure_attention: false,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_arguments_require_explicit_non_flag_values() {
        let args = vec!["--broker-pipe".into(), r"\\.\pipe\agent".into()];
        assert_eq!(
            required_arg(&args, "--broker-pipe").unwrap(),
            r"\\.\pipe\agent"
        );
        let missing_value = vec!["--broker-pipe".into(), "--nonce".into()];
        assert!(required_arg(&missing_value, "--broker-pipe").is_err());
        assert!(required_arg(&args, "--nonce").is_err());
    }
}
