// Prevents an extra console window from appearing on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    personal_edr_app_lib::run();
}
