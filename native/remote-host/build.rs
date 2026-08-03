#[cfg(windows)]
fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let mut resource = winres::WindowsResource::new();
    resource
        .set("CompanyName", "EZTerminal")
        .set("FileDescription", "EZTerminal Remote Host")
        .set("InternalName", "ezterminal-remote-host")
        .set("OriginalFilename", "ezterminal-remote-host.exe")
        .set("ProductName", "EZTerminal")
        .set("ProductVersion", version)
        .set("FileVersion", version)
        .set("LegalCopyright", "Copyright (c) EZTerminal");
    resource
        .compile()
        .expect("compile Windows version resource");
}

#[cfg(not(windows))]
fn main() {}
