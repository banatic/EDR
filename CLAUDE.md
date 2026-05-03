# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PersonalEDR — ETW-based personal behavior analysis tool for Windows. Rust workspace + Tauri 2.0 desktop shell. Spec lives in `personal_edr_spec.html` and is the source of truth for product requirements.

## Common commands

```powershell
# Single-command desktop build (preferred path)
cd app
npm install              # first time only
npm run tauri:build      # produces target/release/personal-edr-app.exe + MSI/NSIS installers
npm run tauri:dev        # HMR development

# Rust workspace
cargo check --workspace
cargo test --workspace
cargo test -p edr-rules suspicious_office_child   # single test by name
cargo check -p edr-collector --features etw,integrity   # validate Windows-only ETW path

# CLI binary (separate from desktop app)
cargo run --bin edr -- run --rules config/rules.yaml --whitelist config/whitelist.toml --seconds 30
cargo run --bin edr --features etw -- run --backend etw    # real ETW (admin shell required)
```

The Tauri shell already runs the full pipeline; the CLI exists for headless operation and feature-gated testing (e.g. `--features duckdb`, which the desktop app doesn't enable because it requires CMake).

## Architecture: pipeline shape

Every event flows through the same chain regardless of frontend:

```
Collector → mpsc → EventProcessor → RuleEngine → mpsc → Pipeline → EventStore
                   (cluster crate)  (rules crate)        (store crate)
```

- **`edr-core`** — shared `Event` schema (`ts/pid/ppid/proc_name/category/op/target/severity/meta`) and `Severity`/`Category` enums. Every other crate depends on this.
- **`edr-collector`** — produces events. Three feature-gated backends:
  - `synthetic` (default, cross-platform): scripted scenario generator for UI dev/tests
  - `etw` (Windows): real-time kernel events
  - `integrity` (Windows): `ntdll!EtwEventWrite` prologue watchdog
- **`edr-cluster`** — `EventProcessor` does whitelist tagging, sliding-window dedup, and first-seen detection. Mutates `event.meta` in place; returns `Emit | Drop | Aggregate`.
- **`edr-rules`** — `RuleEngine` loads YAML rules and matches them against events. Stateful (tracks `pid → proc_name`) so `parent + spawn` rules work.
- **`edr-store`** — `EventStore` trait. Default `MemoryStore` (ring buffer); `DuckDbStore` behind `duckdb` feature.
- **`edr-cli`** (`crates/edr-cli`) — CLI orchestrator (`edr` binary).
- **`app/src-tauri`** (`personal-edr-app`) — Tauri shell. `lib.rs::run()` builds exactly the same pipeline as the CLI and broadcasts each post-processed event on `edr://event` for the React UI.

When adding a new pipeline stage, place it between `EventProcessor` and `RuleEngine` (or after rules) in both `crates/edr-cli/src/main.rs::cmd_run` AND `app/src-tauri/src/lib.rs::run`. These are the two integration points.

## ETW: critical context

The legacy `NT Kernel Logger` is **not** used. It's a system-wide singleton and Windows 10/11 components (DiagTrack, Defender, WdiContext, …) routinely hold its kernel-flag lock — `StartTraceW` then returns `AlreadyExist` even when no session by that name exists, and `StopTrace` rejects with `WMI_INSTANCE_NOT_FOUND`. We use **manifest-based user-mode providers** instead:

- `Microsoft-Windows-Kernel-Process` (incl. ImageLoad/Unload — promoted to `Category::ImageLoad` based on opcode)
- `Microsoft-Windows-Kernel-File`
- `Microsoft-Windows-Kernel-Network`
- `Microsoft-Windows-Kernel-Registry`

Field names differ from the legacy schema. The parser in `crates/edr-collector/src/etw/providers.rs::parse_event` uses fallback chains (`ProcessID` → `ProcessId`, `ImageName` → `ImageFileName`, etc.) — extend these chains rather than picking one name.

`KernelTrace::start_and_process()` and `UserTrace::start_and_process()` return immediately. The trace handle's `Drop` stops the session, so the session loop must keep the handle alive (currently parks on `tx.is_closed()`). Don't `drop(trace)` early — that's a regression we already fixed once.

## Tauri shell wiring

- `rules.yaml` and `whitelist.toml` are baked into the binary via `include_str!` (see `BUNDLED_RULES_YAML` / `BUNDLED_WHITELIST_TOML` in `app/src-tauri/src/lib.rs`). Edit `config/*` and rebuild — there is no runtime config-file lookup.
- Backend selection happens at startup based on `edr_collector::elevation_status()`. Result + any ETW failure reason is appended to `%TEMP%\personal-edr-startup.log` — that file is the primary debugging surface in release builds because `windows_subsystem = "windows"` kills stdout.
- Don't call `tokio::spawn` from the Tauri `setup` callback (sync, no runtime context active). Use `tauri::async_runtime::spawn` for tasks, or `std::thread::spawn` + `Sender::blocking_send` (see `IntegrityWatch`).
- `IntegrityWatch::spawn` returns a handle whose `Drop` joins the worker thread. The shell intentionally `std::mem::forget`s it so the watchdog runs for the lifetime of the process.

## Behavior conventions

- Cargo features are non-default for paths that need external toolchains: `duckdb` requires CMake; `etw` requires Windows + admin at runtime. The desktop app crate (`personal-edr-app`) hard-codes `etw + integrity` as default, so `cargo check -p personal-edr-app` exercises the Windows path.
- When ETW or any singleton system resource conflicts, **identify before acting**. There is a memory entry (`feedback_shared_resources.md`) with the rationale: don't blindly call `stop_trace_by_name` on a name that other tools might own. The current code only auto-stops sessions whose name is private to PersonalEDR (`PersonalEDR-Kernel`).
- Tests are a hard signal — current count is 47 across the workspace and is expected to stay green. Run `cargo test --workspace --exclude personal-edr-app` (the Tauri shell has no unit tests; its integration is verified by `cargo check`).
