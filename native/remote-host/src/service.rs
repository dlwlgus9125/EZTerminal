use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use windows_service::define_windows_service;
use windows_service::service::{
    Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_dispatcher;
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::SERVICE_NAME;
use crate::protocol::ServiceAvailability;

const DISPLAY_NAME: &str = "EZTerminal Remote Desktop Host";
const DESCRIPTION: &str = "Authenticated local capability broker and active-session agent supervisor for EZTerminal remote desktop.";
const LOCAL_SYSTEM_ACCOUNT: &str = r".\LocalSystem";
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
        current_state: ServiceState::StartPending,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 1,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    })?;

    let broker_shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&broker_shutdown);
    let (broker_result_tx, broker_result_rx) = mpsc::sync_channel(1);
    let (broker_startup_tx, broker_startup_rx) = mpsc::sync_channel(1);
    let broker_worker = thread::spawn(move || {
        let _ = broker_result_tx.send(crate::local_broker::serve(
            worker_shutdown,
            broker_startup_tx,
        ));
    });

    if !matches!(
        broker_startup_rx.recv_timeout(Duration::from_secs(10)),
        Ok(Ok(()))
    ) {
        broker_shutdown.store(true, Ordering::Release);
        let _ = broker_worker.join();
        status.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(1),
            checkpoint: 0,
            wait_hint: Duration::ZERO,
            process_id: None,
        })?;
        return Ok(());
    }

    status.set_service_status(ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::ZERO,
        process_id: None,
    })?;

    // This service owns only authenticated local named pipes. WebRTC UDP and
    // signaling remain in the unprivileged transport process.
    let mut broker_failed = false;
    loop {
        if shutdown_rx.try_recv().is_ok() {
            break;
        }
        match broker_result_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ok(())) => break,
            Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                broker_failed = true;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    status.set_service_status(ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: ServiceState::StopPending,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 1,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    })?;
    broker_shutdown.store(true, Ordering::Release);
    let _ = broker_worker.join();

    status.set_service_status(ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code: ServiceExitCode::Win32(u32::from(broker_failed)),
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
    let info = desired_service_info(executable);

    let (service, created) = match manager.create_service(&info, access) {
        Ok(service) => (service, true),
        Err(_) => (
            manager
                .open_service(SERVICE_NAME, access)
                .context("opening existing EZTerminal remote service")?,
            false,
        ),
    };
    if !created {
        stop_for_reconfiguration(&service, Duration::from_secs(10))?;
        service
            .change_config(&info)
            .context("updating existing EZTerminal remote service configuration")?;
    }
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
        service.start::<&OsStr>(&[])?;
    }
    wait_for_running(&service, Duration::from_secs(10))
}

fn desired_service_info(executable_path: PathBuf) -> ServiceInfo {
    ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: SERVICE_TYPE,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path,
        launch_arguments: vec![OsString::from("--service")],
        dependencies: vec![],
        // Unlike a null account on ChangeServiceConfigW (which means
        // "unchanged"), an explicit LocalSystem name repairs stale service
        // credentials during an installer upgrade.
        account_name: Some(OsString::from(LOCAL_SYSTEM_ACCOUNT)),
        account_password: Some(OsString::new()),
    }
}

fn stop_for_reconfiguration(service: &Service, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut stop_requested = false;
    loop {
        match service.query_status()?.current_state {
            ServiceState::Stopped => return Ok(()),
            ServiceState::StopPending => {
                stop_requested = true;
            }
            ServiceState::StartPending => {}
            _ if !stop_requested => {
                service
                    .stop()
                    .context("stopping existing EZTerminal remote service for upgrade")?;
                stop_requested = true;
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            bail!("existing EZTerminal remote service did not stop for reconfiguration");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn wait_for_running(service: &Service, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if service.query_status()?.current_state == ServiceState::Running {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("EZTerminal remote service did not report ready before the startup deadline");
        }
        thread::sleep(Duration::from_millis(100));
    }
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

pub(crate) fn process_id() -> Option<u32> {
    let manager =
        ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .ok()?;
    let status = service.query_status().ok()?;
    (status.current_state == ServiceState::Running)
        .then_some(status.process_id)
        .flatten()
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

    #[test]
    fn installer_configuration_is_upgrade_safe_and_explicitly_local_system() {
        let executable = PathBuf::from(r"C:\Program Files\EZTerminal\remote-host.exe");
        let info = desired_service_info(executable.clone());
        assert_eq!(info.executable_path, executable);
        assert_eq!(info.launch_arguments, vec![OsString::from("--service")]);
        assert_eq!(info.start_type, ServiceStartType::AutoStart);
        assert_eq!(
            info.account_name.as_deref(),
            Some(OsStr::new(LOCAL_SYSTEM_ACCOUNT))
        );
        assert_eq!(info.account_password.as_deref(), Some(OsStr::new("")));
        assert!(!DESCRIPTION.contains("capture"));
        assert!(!DESCRIPTION.contains("secure input"));
    }
}
