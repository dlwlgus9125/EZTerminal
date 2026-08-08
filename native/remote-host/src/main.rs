use std::process::ExitCode;

#[cfg(all(windows, feature = "windows-host"))]
fn main() -> ExitCode {
    use ezterminal_remote_host::{dpi, process_guardian, service, session_agent, transport};

    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(
        args.first().map(String::as_str),
        Some("--session-agent" | "--transport")
    ) && let Err(error) = dpi::ensure_per_monitor_v2()
    {
        eprintln!("ezterminal remote host failed: {error:#}");
        return ExitCode::FAILURE;
    }
    let result = match args.first().map(String::as_str) {
        Some("--service") => service::run_dispatcher(),
        Some("--install-service") => service::install(),
        Some("--uninstall-service") => service::uninstall(),
        Some("--session-agent") => session_agent::run(&args[1..]),
        Some("--transport") => transport::run(),
        Some("--process-guardian") => process_guardian::run(&args[1..]),
        Some("--probe") => service::probe(),
        _ => {
            eprintln!(
                "usage: ezterminal-remote-host.exe --service|--install-service|--uninstall-service|--session-agent|--transport|--process-guardian|--probe"
            );
            return ExitCode::from(2);
        }
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("ezterminal remote host failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(all(windows, feature = "windows-host")))]
fn main() -> ExitCode {
    eprintln!("the EZTerminal remote host requires Windows and the windows-host feature");
    ExitCode::FAILURE
}
