use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::mem::size_of;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_EVENT, WAIT_OBJECT_0};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    PROCESS_TERMINATE, WaitForSingleObject,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{BOOL, PCWSTR};

const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
const GUARDIAN_EXIT_CODE: u32 = 0x455A_0001;

#[derive(Debug)]
struct OwnedHandle(HANDLE);

// Windows kernel handles may be waited on and closed from another thread.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[derive(Debug)]
struct ProcessGroup {
    job: OwnedHandle,
    parent_group_id: Option<String>,
}

type SharedGroups = Arc<Mutex<HashMap<String, ProcessGroup>>>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum GuardianCommand {
    CreateGroup {
        id: String,
        group_id: String,
        pid: u32,
        #[serde(default)]
        parent_group_id: Option<String>,
    },
    TerminateGroup {
        id: String,
        group_id: String,
    },
    ArmRootDeadline {
        id: String,
        timeout_ms: u64,
    },
    ForceRoot {
        id: String,
    },
    ShellHandoff {
        id: String,
        action: ShellHandoffAction,
        target: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ShellHandoffAction {
    Open,
    Reveal,
}

impl GuardianCommand {
    fn id(&self) -> &str {
        match self {
            Self::CreateGroup { id, .. }
            | Self::TerminateGroup { id, .. }
            | Self::ArmRootDeadline { id, .. }
            | Self::ForceRoot { id }
            | Self::ShellHandoff { id, .. } => id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum GuardianResponse<'a> {
    Ready { owner_pid: u32 },
    Ok { id: &'a str },
    Error { id: &'a str, message: String },
}

fn write_response(response: &GuardianResponse<'_>) -> Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, response).context("serializing guardian response")?;
    stdout
        .write_all(b"\n")
        .context("writing guardian response")?;
    stdout.flush().context("flushing guardian response")
}

fn create_kill_on_close_job() -> Result<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .context("creating process guardian job object")?;
    let job = OwnedHandle(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .context("enabling kill-on-close on guardian job object")?;
    }
    Ok(job)
}

fn open_assignable_process(pid: u32) -> Result<OwnedHandle> {
    if pid == 0 {
        bail!("process id must be non-zero");
    }
    let rights = PROCESS_ACCESS_RIGHTS(
        PROCESS_SET_QUOTA.0
            | PROCESS_TERMINATE.0
            | PROCESS_QUERY_LIMITED_INFORMATION.0
            | SYNCHRONIZE_ACCESS,
    );
    let handle = unsafe { OpenProcess(rights, false, pid) }
        .with_context(|| format!("opening process {pid} for guardian ownership"))?;
    Ok(OwnedHandle(handle))
}

fn assign_process(job: &OwnedHandle, process: &OwnedHandle, context: &str) -> Result<()> {
    unsafe { AssignProcessToJobObject(job.0, process.0) }
        .with_context(|| format!("assigning {context} to guardian job"))
}

fn wait_for_process(process: &OwnedHandle) -> WAIT_EVENT {
    unsafe { WaitForSingleObject(process.0, u32::MAX) }
}

fn verify_root_member(root_job: &OwnedHandle, process: &OwnedHandle) -> Result<()> {
    let mut in_job = BOOL::default();
    unsafe { IsProcessInJob(process.0, Some(root_job.0), &mut in_job) }
        .context("checking process guardian root membership")?;
    if !in_job.as_bool() {
        bail!("refusing to group a process outside the EZTerminal root job");
    }
    Ok(())
}

fn terminate_group_tree(groups: &SharedGroups, group_id: &str) {
    let removed = {
        let Ok(mut locked) = groups.lock() else {
            return;
        };
        let mut ids = vec![group_id.to_owned()];
        let mut cursor = 0;
        while cursor < ids.len() {
            let parent = ids[cursor].clone();
            for (candidate_id, group) in locked.iter() {
                if group.parent_group_id.as_deref() == Some(parent.as_str())
                    && !ids.contains(candidate_id)
                {
                    ids.push(candidate_id.clone());
                }
            }
            cursor += 1;
        }
        ids.into_iter()
            .rev()
            .filter_map(|id| locked.remove(&id))
            .collect::<Vec<_>>()
    };
    for group in removed {
        unsafe {
            let _ = TerminateJobObject(group.job.0, GUARDIAN_EXIT_CODE);
        }
    }
}

fn create_group(
    root_job: &OwnedHandle,
    groups: &SharedGroups,
    group_id: &str,
    pid: u32,
    parent_group_id: Option<String>,
) -> Result<()> {
    if group_id.is_empty() || group_id.len() > 256 {
        bail!("group id must contain 1..256 characters");
    }
    {
        let locked = groups
            .lock()
            .map_err(|_| anyhow::anyhow!("guardian group lock poisoned"))?;
        if locked.contains_key(group_id) {
            bail!("process group already exists");
        }
        if let Some(parent) = parent_group_id.as_deref()
            && !locked.contains_key(parent)
        {
            bail!("parent process group does not exist");
        }
    }

    let process = open_assignable_process(pid)?;
    verify_root_member(root_job, &process)?;
    let job = create_kill_on_close_job()?;
    assign_process(&job, &process, "owned worker")?;

    groups
        .lock()
        .map_err(|_| anyhow::anyhow!("guardian group lock poisoned"))?
        .insert(
            group_id.to_owned(),
            ProcessGroup {
                job,
                parent_group_id,
            },
        );

    let watched_group_id = group_id.to_owned();
    let watched_groups = Arc::clone(groups);
    thread::spawn(move || {
        let _ = wait_for_process(&process);
        terminate_group_tree(&watched_groups, &watched_group_id);
    });
    Ok(())
}

fn parse_owner_pid(args: &[String]) -> Result<u32> {
    if args.len() != 2 || args[0] != "--owner-pid" {
        bail!("usage: --process-guardian --owner-pid <pid>");
    }
    args[1].parse::<u32>().context("parsing guardian owner pid")
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn validate_shell_target(target: &str) -> Result<()> {
    if target.is_empty() || target.len() > 32_768 {
        bail!("shell handoff target must contain 1..32768 bytes");
    }
    if target.contains('\0') {
        bail!("shell handoff target contains a null character");
    }
    Ok(())
}

fn shell_handoff(action: ShellHandoffAction, target: &str) -> Result<()> {
    validate_shell_target(target)?;
    let operation = wide("open");
    let target_wide;
    let parameters_wide;
    let (file, parameters) = match action {
        ShellHandoffAction::Open => {
            target_wide = wide(target);
            (PCWSTR(target_wide.as_ptr()), PCWSTR::null())
        }
        ShellHandoffAction::Reveal => {
            target_wide = wide("explorer.exe");
            parameters_wide = wide(&format!(r#"/select,"{target}""#));
            (
                PCWSTR(target_wide.as_ptr()),
                PCWSTR(parameters_wide.as_ptr()),
            )
        }
    };
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            file,
            parameters,
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let result_code = result.0 as usize;
    if result_code <= 32 {
        bail!("Windows shell handoff failed with code {result_code}");
    }
    Ok(())
}

pub fn run(args: &[String]) -> Result<()> {
    let owner_pid = parse_owner_pid(args)?;
    let owner = open_assignable_process(owner_pid)?;
    let root_job = Arc::new(create_kill_on_close_job()?);
    assign_process(&root_job, &owner, "EZTerminal main process")?;

    let watched_root = Arc::clone(&root_job);
    thread::spawn(move || {
        let result = wait_for_process(&owner);
        if result == WAIT_OBJECT_0 {
            unsafe {
                let _ = TerminateJobObject(watched_root.0, GUARDIAN_EXIT_CODE);
            }
        }
        std::process::exit(0);
    });

    write_response(&GuardianResponse::Ready { owner_pid })?;
    let groups: SharedGroups = Arc::new(Mutex::new(HashMap::new()));
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.context("reading guardian command")?;
        if line.trim().is_empty() {
            continue;
        }
        let command = match serde_json::from_str::<GuardianCommand>(&line) {
            Ok(command) => command,
            Err(error) => {
                write_response(&GuardianResponse::Error {
                    id: "",
                    message: format!("invalid guardian command: {error}"),
                })?;
                continue;
            }
        };
        let command_id = command.id().to_owned();
        let result = match command {
            GuardianCommand::CreateGroup {
                group_id,
                pid,
                parent_group_id,
                ..
            } => create_group(&root_job, &groups, &group_id, pid, parent_group_id),
            GuardianCommand::TerminateGroup { group_id, .. } => {
                terminate_group_tree(&groups, &group_id);
                Ok(())
            }
            GuardianCommand::ArmRootDeadline { timeout_ms, .. } => {
                let deadline_root = Arc::clone(&root_job);
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(timeout_ms.clamp(1, 60_000)));
                    unsafe {
                        let _ = TerminateJobObject(deadline_root.0, GUARDIAN_EXIT_CODE);
                    }
                    std::process::exit(0);
                });
                Ok(())
            }
            GuardianCommand::ForceRoot { .. } => {
                unsafe { TerminateJobObject(root_job.0, GUARDIAN_EXIT_CODE) }
                    .context("terminating guardian root job")
            }
            GuardianCommand::ShellHandoff { action, target, .. } => shell_handoff(action, &target),
        };
        match result {
            Ok(()) => write_response(&GuardianResponse::Ok { id: &command_id })?,
            Err(error) => write_response(&GuardianResponse::Error {
                id: &command_id,
                message: format!("{error:#}"),
            })?,
        }
    }

    // EOF means the owning main process released its control pipe. Closing the
    // guardian process drops every job handle and enforces shared fate.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exact_owner_argument() {
        assert_eq!(
            parse_owner_pid(&["--owner-pid".into(), "42".into()]).unwrap(),
            42
        );
        assert!(parse_owner_pid(&[]).is_err());
        assert!(parse_owner_pid(&["--owner-pid".into(), "0x2a".into()]).is_err());
    }

    #[test]
    fn command_protocol_rejects_unknown_variants() {
        assert!(serde_json::from_str::<GuardianCommand>(r#"{"type":"unknown","id":"x"}"#).is_err());
    }

    #[test]
    fn shell_handoff_protocol_is_typed_and_validated() {
        assert!(serde_json::from_str::<GuardianCommand>(
            r#"{"type":"shell-handoff","id":"x","action":"open","target":"https://example.com"}"#,
        )
        .is_ok());
        assert!(
            serde_json::from_str::<GuardianCommand>(
                r#"{"type":"shell-handoff","id":"x","action":"execute","target":"cmd.exe"}"#,
            )
            .is_err()
        );
        assert!(validate_shell_target("").is_err());
        assert!(validate_shell_target("bad\0target").is_err());
    }
}
