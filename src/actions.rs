//! Shell integration: open, reveal, properties, external editor and elevation.

use std::io;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

/// `ShellExecuteW` with the given verb (`open`, `runas`, …).
#[cfg(windows)]
fn shell_execute(verb: &str, file: &str, params: Option<&str>) -> io::Result<()> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let (verb, file) = (wide(verb), wide(file));
    let params = params.map(wide);
    // SAFETY: all strings are NUL-terminated UTF-16 and outlive the call.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Values above 32 mean success.
    if result as isize > 32 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// Opens a file or folder with its default application.
pub fn open(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        shell_execute("open", &path.to_string_lossy(), None)
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(path).spawn().map(|_| ())
    }
}

/// Opens Explorer with the item selected.
pub fn reveal(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map(|_| ())
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open").arg(path.parent().unwrap_or(path)).spawn().map(|_| ())
    }
}

/// Shows the Windows file properties dialog.
pub fn properties(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::{SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW, ShellExecuteExW};
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let verb = wide("properties");
        let file = wide(&path.to_string_lossy());
        // SAFETY: zero is a valid initial state for this plain struct.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_INVOKEIDLIST;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.nShow = SW_SHOWNORMAL;
        // SAFETY: `info` is initialised and its strings outlive the call.
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(io::Error::other("not supported on this platform"))
    }
}

/// The editor command: `POUNCE_EDITOR`, `VISUAL`, `EDITOR`, else Notepad.
pub fn default_editor() -> String {
    ["POUNCE_EDITOR", "VISUAL", "EDITOR"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "notepad".to_string())
}

/// Launches `editor` (a command line such as `code -n`) with the file appended.
pub fn edit_externally(editor: &str, path: &Path) -> io::Result<()> {
    let mut parts = editor.split_whitespace();
    let program = parts.next().unwrap_or("notepad");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // Through cmd so .cmd shims (e.g. VS Code's `code`) resolve; no console window flashes.
        Command::new("cmd")
            .arg("/C")
            .arg(program)
            .args(parts)
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
    }
    #[cfg(not(windows))]
    {
        Command::new(program).args(parts).arg(path).spawn().map(|_| ())
    }
}

/// Starts a new elevated instance of this program (UAC prompt). Returns Ok when it launched.
pub fn restart_elevated() -> io::Result<()> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()?;
        shell_execute("runas", &exe.to_string_lossy(), None)
    }
    #[cfg(not(windows))]
    {
        Err(io::Error::other("not supported on this platform"))
    }
}
