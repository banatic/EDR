# PersonalEDR

ETW 기반 개인용 행위 분석 도구. Rust 백엔드 + Tauri 데스크톱 셸.
스펙: `personal_edr_spec.html`

## 요구 사항

- Rust stable (MSVC 툴체인)
- Node.js 20+ / npm
- 실제 ETW 수집 시: **관리자 권한** + Windows 10/11
- DuckDB 영구 저장 시: CMake (`winget install Kitware.CMake`)

## 디렉토리

```
crates/
  edr-core/       Event 스키마
  edr-store/      EventStore trait + MemoryStore + DuckDbStore(opt)
  edr-collector/  Synthetic / ETW / EtwEventWrite 무결성 워치독
  edr-cluster/    화이트리스트 + sliding-window dedup + first-seen
  edr-rules/      YAML 룰 엔진
  edr-cli/        edr 바이너리
app/              Tauri 2.0 + React + TypeScript 데스크톱 셸
config/
  whitelist.toml  화이트리스트 시작 파일
  rules.yaml      탐지 룰 시작 파일
```

## 빌드 & 실행

```powershell
cd app
npm install
npm run tauri:build
```

산출물:

| 경로 | 설명 |
|---|---|
| `target/release/personal-edr-app.exe` | 단독 실행 바이너리 (~11MB) |
| `target/release/bundle/msi/PersonalEDR_*.msi` | MSI 인스톨러 |
| `target/release/bundle/nsis/PersonalEDR_*-setup.exe` | NSIS 인스톨러 |

`.exe`를 더블클릭하면 실행된다.
- **일반 실행** → ETW 권한이 없어 synthetic 백엔드(데모용 가짜 이벤트)로 동작
- **관리자로 실행** (우클릭 → 관리자 권한) → 실제 ETW 커널 세션 + EtwEventWrite 무결성 워치독 작동

룰(`config/rules.yaml`)과 화이트리스트(`config/whitelist.toml`)는 빌드 시점에 바이너리에 포함된다. 변경하면 다시 `npm run tauri:build` 하면 된다.

### 개발 모드 (HMR)

```powershell
cd app
npm run tauri:dev
```

### CLI 단독 사용 (선택)

```powershell
cargo run --bin edr -- run --seconds 30                          # synthetic
cargo run --bin edr --features etw -- run --backend etw          # 실제 ETW (관리자)
cargo run --bin edr --features duckdb -- run --db data/edr.db    # DuckDB 영구 저장
```

## 설정 파일

### `config/whitelist.toml`

```toml
[[whitelist]]
proc = "chrome.exe"
category = "network"
target_pattern = "*.google.com"
```

매칭 이벤트는 `meta.whitelisted=true`로 태깅된다 (UI에서 흐리게 표시).

### `config/rules.yaml`

```yaml
- name: suspicious_office_child
  condition:
    parent: ["winword.exe","excel.exe","powerpnt.exe"]
    spawn:  ["cmd.exe","powershell.exe","wscript.exe"]
  severity: 2
```

지원 키: `category`, `op`, `parent`, `spawn`, `target_proc`, `target_pattern` (glob `*`), `not_whitelist`.

## Cargo features

| crate | feature | 기본 | 설명 |
|---|---|---|---|
| edr-collector | `etw` | 데스크톱 앱: ON | 실제 NT Kernel Logger 수집 |
| edr-collector | `integrity` | 데스크톱 앱: ON | EtwEventWrite 워치독 |
| edr-store | `duckdb` | OFF | DuckDB 영구 저장 (CMake 필요) |
| edr-cli | `etw` / `duckdb` | OFF | CLI에서 활성화 시 사용 |

데스크톱 앱(`personal-edr-app`)은 `etw` + `integrity`가 기본 ON이고, 런타임에 권한을 보고 ETW/synthetic 자동 전환한다.

## CLI 명령

```
edr run    --backend [synthetic|etw] [--seconds N] [--db PATH] [--rules PATH] [--whitelist PATH]
edr stats  [--db PATH]
edr query  [--db PATH] [--pid N] [--category C] [--min-severity 0..2] [--limit N]
```
