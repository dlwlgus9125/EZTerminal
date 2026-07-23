use std::ffi::OsString;
use std::path::Path;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use windows_service::define_windows_service;
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_dispatcher;
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::SERVICE_NAME;
use crate::protocol::ServiceAvailability;

const DISPLAY_NAME: &str = "EZTerminal Remote Desktop Host";
const DESCRIPTION: &str =
    "Privileged local broker for EZTerminal remote desktop capture and secure input.";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

define_windows_service!(ffi_service_main, service_main);

pub fn run_dispatcher() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("registering with the Windows service dispatcher")?;
    Ok(())
}

fn service_main(_arguments: Vec<OsString>) {
    let _ = run_service();
}

fn run_service() -> windows_service::Result<()> {
    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
    let event_handler = move |control| -> ServiceControlHandlerResult {
        match control {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = shutdown_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };

    let status = service_control_handler::register(SERVICE_NAME, event_handler)?;
    status.set_service_status(ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    })?;

    // The broker intentionally owns no network socket. Lease/agent pipe serving is
    // activated by the installed transport in the next layer; until then this
    // blocking wait keeps the service passive and cheap at boot.
    let _ = shutdown_rx.recv();

    status.set_service_status(ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    })?;
    Ok(())
}

pub fn install() -> Result<()> {
    let executable = std::env::current_exe().context("resolving service executable")?;
    validate_install_path(&executable)?;

    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .context("opening Windows Service Control Manager")?;
    let access = ServiceAccess::QUERY_CONFIG
        | ServiceAccess::QUERY_STATUS
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE;
    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: SERVICE_TYPE,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: executable,
        launch_arguments: vec![OsString::from("--service")],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };

    let service = match manager.create_service(&info, access) {
        Ok(service) => service,
        Err(_) => manager
            .open_service(SERVICE_NAME, access)
            .context("opening existing EZTerminal remote service")?,
    };
    service.set_description(DESCRIPTION)?;
    service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 60 * 60)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(5),
            },
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(15),
            },
            ServiceAction {
                action_type: ServiceActionType::None,
                delay: Duration::ZERO,
            },
        ]),
    })?;
    service.set_failure_actions_on_non_crash_failures(true)?;

    if service.query_status()?.current_state == ServiceState::Stopped {
        service.start::<&OsString>(&[])?;
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .context("opening Windows Service Control Manager")?;
    let service = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(service) => service,
        Err(_) => return Ok(()),
    };

    service
        .delete()
        .context("marking remote service for deletion")?;
    if service.query_status()?.current_state != ServiceState::Stopped {
        let _ = service.stop();
    }
    drop(service);

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        if manager
            .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
            .is_err()
        {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    bail!("service is still pending deletion")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    protocol_version: u16,
    service: ServiceAvailability,
    service_name: &'static str,
}

pub fn probe() -> Result<()> {
    let result = ProbeResult {
        protocol_version: crate::NATIVE_PROTOCOL_VERSION,
        service: availability(),
        service_name: SERVICE_NAME,
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

pub fn availability() -> ServiceAvailability {
    let Ok(manager) = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
    else {
        return ServiceAvailability::Denied;
    };
    let Ok(service) = manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) else {
        return ServiceAvailability::Missing;
    };
    match service.query_status().map(|status| status.current_state) {
        Ok(ServiceState::Running) => ServiceAvailability::Ready,
        Ok(_) => ServiceAvailability::Stopped,
        Err(_) => ServiceAvailability::Denied,
    }
}

fn validate_install_path(path: &Path) -> Result<()> {
    validate_install_path_with(
        path,
        std::env::var_os("ProgramFiles").as_deref(),
        std::env::var_os("EZTERMINAL_REMOTE_ALLOW_DEV_INSTALL").is_some(),
    )
}

fn validate_install_path_with(
    path: &Path,
    program_files: Option<&std::ffi::OsStr>,
    allow_dev_install: bool,
) -> Result<()> {
    if allow_dev_install {
        return Ok(());
    }
    let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let program_files = program_files
        .unwrap_or_else(|| std::ffi::OsStr::new(r"C:\Program Files"))
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    if !normalized.starts_with(&(program_files + "\\")) {
        bail!("refusing to register a LocalSystem service outside Program Files")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_path_is_fail_closed_outside_program_files() {
        assert!(
            validate_install_path_with(
                Path::new(r"C:\Users\person\remote-host.exe"),
                Some(std::ffi::OsStr::new(r"C:\Program Files")),
                false,
            )
            .is_err()
        );
        assert!(
            validate_install_path_with(
                Path::new(r"C:\Program Files\EZTerminal\remote-host.exe"),
                Some(std::ffi::OsStr::new(r"C:\Program Files")),
                false,
            )
            .is_ok()
        );
    }
}
