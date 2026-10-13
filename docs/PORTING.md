# isrprof 포팅 가이드 — 입력과 결과

새 환경(다른 PC, 다른 펌웨어 트리)에 isrprof를 옮겨 쓰기 위해 필요한 모든 것을 정리한 문서입니다.
입력은 **프로파일 디렉터리 하나**, 결과는 **출력 디렉터리 하나**로 닫혀 있으므로, 그 두 가지만 이해하면 포팅이 끝납니다.

---

## 1. 실행 환경

| 항목 | 요구 사항 |
|---|---|
| Python | 3.10 이상 (`X \| None` 타입 힌트 사용) |
| 필수 패키지 | `pyyaml>=6.0` |
| 선택 패키지 | `libclang` (deep 분석 clang 백엔드), `ziglang` (deep 분석 objects 백엔드의 크로스 컴파일), `esprima` (뷰어 JS 문법 검사), `anthropic` (LLM 보조 기능을 켤 때만) |
| 브라우저 | 뷰어는 아무 최신 브라우저로 열면 됨(오프라인 동작, three.js 내장). 자동 검증·스크린샷에는 Edge 또는 Chrome 필요 |
| OS | Windows / Linux / macOS 모두 가능 (검증 도구는 어떤 셸에서든 동작) |
| 빌드 도구 | 불필요. CMake는 `compile_commands.json`을 만들 때만 쓰임. deep 분석의 objects 백엔드는 `deep.build.run: true` 일 때만 프로젝트 빌드를 실행하고, 그 외에는 pip 의 zig 로 직접 컴파일 |

```bash
pip install pyyaml            # 필수
pip install esprima           # 선택: python tools/check_js.py
pip install libclang ziglang  # 선택: deep 분석 (clang 프런트엔드 / 실제 크로스 컴파일 + ELF 리더)
```

## 2. 복사할 파일

```
isrprof/                       # 이 디렉터리 전체를 복사하면 됨
  isrprof/                     # 패키지 (파이프라인 + 뷰어 템플릿 + 내장 three.js)
  profiles/                    # 입력(프로파일). 새 타깃마다 하위 디렉터리 하나
  examples/                    # 샘플 소스 (nr_modem) — 새 환경에서는 없어도 됨
  tools/                       # 검증·스크린샷·합성 트리·compile_commands 생성 스크립트
  tests/                       # 단위 테스트
  output/                      # 결과 (자동 생성, gitignore)
```

프로파일 디렉터리를 다른 곳에 두고 싶으면 환경 변수 `ISRPROF_PROFILES=<경로>` 또는 `--profiles-dir <경로>` 옵션을 씁니다.

## 3. 입력: 프로파일 디렉터리

```
profiles/<name>/
  profile.yaml          이름, 사용할 입력 파일, 출력 위치, 뷰어 옵션, (선택) LLM
  build.yaml            소스 위치와 빌드 정보
  sw_structure.yaml     SW 구조 (위 오버레이) + touch 규칙 + 아키텍처 규칙
  timing.yaml           3D 타이밍 다이어그램 (가운데 오버레이)
  hw_structure.yaml     HW 구조 (아래 오버레이) + 레지스터 접근 매크로
  annotations.yaml      (선택) 툴팁에 보일 자유 텍스트 메모
```

상대 경로 규칙: `profile.yaml` 안의 경로는 프로파일 디렉터리 기준, `build.yaml`의 `root`도 프로파일 디렉터리 기준,
**그 외의 파일 glob(`sw_structure.yaml`의 `files`, 레이어의 `files`)은 모두 `build.root` 기준**입니다.
시간 표현은 어디서나 `"1.2 symbol"`, `"0.5 slot"`, `"-30 us"`, `"2 ms"`, `"1 subframe"` 형식이며 단위 없는 숫자는 symbol입니다.

### 3.1 profile.yaml

| 키 | 의미 | 기본값 |
|---|---|---|
| `name` | 프로파일 이름 (출력 디렉터리 이름) | 디렉터리 이름 |
| `description` | 설명 (list에 표시) | |
| `inputs.build / sw_structure / timing / hw_structure / annotations` | 각 입력 파일 경로 | 같은 이름의 yaml |
| `output.dir` | 출력 디렉터리 | `<profiles>/../output/<name>` |
| `output.html`, `output.json` | 출력 파일 이름 | `profile.html`, `profile.json` |
| `viewer.default_view` | `tilt`(코어 평면을 카드처럼 겹쳐 쌓음) / `aligned`(겹침 없이 나열) / `3d`(원근) | `tilt` |
| `viewer.default_slots` | 로드 시 보여줄 NW slot 수 (상단 Slots 컨트롤로 변경) | 5 |
| `viewer.stack_overlap` | stacked 뷰에서 앞 평면이 뒤 평면을 덮는 비율 0~0.85 (슬라이더로 변경) | 0.5 |
| `viewer.expand_depth` | 로드 시 ISR 진입점 아래로 펼칠 콜그래프 레벨 (0 = 진입점만) | 1 |
| `viewer.row_px` | 호출 깊이 한 행의 픽셀 높이 (Row scale 슬라이더로 배율 조절) | 12 |
| `viewer.sw_structure.depth`, `viewer.hw_structure.depth` | 구조 다이어그램 중첩 깊이 | 3, 2 |
| `viewer.sw_structure.columns`, `.open` | 최상위 열 수, 로드 시 펼칠 노드 id | 4, [] |
| `viewer.max_boxes`, `viewer.max_labels` | 뷰어 LOD 한도 | 40000, 700 |
| `viewer.max_instances` | ISR당 그릴 주기 인스턴스 상한 | 1500 |
| `viewer.dsm_max_functions` | 이 함수 수를 넘으면 DSM을 모듈 접힘 상태로 시작 | 400 |
| `viewer.colors.read/write/miss/heap/accent`, `palette_light/dark` | 색 | 테마 기본 |
| `viewer.unit`, `theme`, `row_px`, `label_margin_px`, `tilt_dx_px`, `legend`, `channels.row_px`, `window_range` | 외관 | |
| `llm.*` | `enabled`, `model`, `api_key_env`, `tasks` 등 (기본 비활성) | |

### 3.2 build.yaml

| 키 | 의미 |
|---|---|
| `root` | 소스 루트 (프로파일 디렉터리 기준 상대 또는 절대) |
| `sources` | 파싱할 파일 glob 목록 (`root` 기준). 헤더도 포함할 것 — 레지스터/접근 매크로 정의와 extern 선언이 거기 있음 |
| `exclude` | 제외 glob |
| `compile_commands` | `compile_commands.json` 경로. 있으면 그 안의 translation unit이 `.c` 목록이 되고 `-D`/`-I`가 파일별로 기록됨 |
| `cmake.source_dir / build_dir / configure` | 기록용. `build_dir/compile_commands.json`이 있으면 자동 사용 |
| `build_command` | 기록용 (실행하지 않음) |
| `defines` | 기록용 추가 define |
| `parser.backend` | `builtin` (기본) 또는 `libclang` (플러그인 `isrprof/clang_backend.py` 필요) |
| `parser.ignore_calls` | 호출로 세지 않을 이름 (`sizeof`, `memcpy`, 잠금 매크로 등) |
| `cache` | 파일별 파싱 캐시 사용 여부 |

`compile_commands.json`이 없을 때: `python tools/gen_compile_commands.py <root> <root>/build/compile_commands.json -DFOO=1 -I.` 로 만들 수 있습니다.

### 3.2.1 build.yaml - deep (빌드 기반) 분석 토글

```yaml
deep:
  enabled: true              # 끄면 토큰 파서만 사용 (실행 시 --deep / --no-deep 로도 전환)
  backend: clang             # clang: libclang + compile_commands 플래그 + 크로스 타깃 (바이너리 생성 없음, Windows에서 ARM 트리 분석 가능)
                             # objects: 실제 오브젝트(.o)를 읽음. 프로젝트 빌드 산출물이 없으면 zig(clang)로 이 PC에서 직접 크로스 컴파일 (pip install ziglang)
                             # both: clang + objects (프런트엔드의 메서드·override·읽기/쓰기 + 오브젝트의 실제 링크 간선)
  scope: ["dl/**", "ul_core"]   # 깊게 분석할 범위: root 기준 glob 또는 SW 노드 id. 비우면 전체 TU. 큰 트리는 작업 중인 모듈만
  exclude: []
  target: arm-none-eabi      # clang --target
  std_c: gnu11
  std_cxx: c++17
  sysroot: C:/tools/gcc-arm-none-eabi/arm-none-eabi   # 툴체인 헤더. 없으면 내장 freestanding 헤더로 파싱 계속
  extra_args: ["-ffreestanding", "-fno-exceptions"]
  jobs: 0                    # 병렬 TU 수 (0 = CPU-1)
  cache: true                # TU별 캐시 (output/<name>/.cache/deep) - 재실행 시 바뀐 파일만
  max_files: 0
  build:                     # objects 백엔드
    run: false               # cmake.configure + build_command 를 먼저 실행할지 (프로젝트 툴체인이 있는 PC)
    objects: ["build/**/*.o"]  # 읽을 오브젝트. 없으면 아래 compile 로 직접 만듦
    compile: auto            # auto: 오브젝트가 없을 때만 zig 로 컴파일 | zig: 항상 | off: 안 함
    zig_target: null         # 비우면 deep.target 을 변환 (arm-none-eabi -> arm-freestanding-eabi, aarch64-none-elf -> aarch64-freestanding-none ...)
    mcpu: cortex_m4          # ARM 기본값. 실제 코어에 맞게 (cortex_a53, cortex_r5 ...)
    zig_args: []             # 추가 컴파일 플래그
    reader: elf              # elf: 내장 ELF 리더 (도구 불필요) | binutils: toolchain nm / objdump 텍스트 파싱 (COFF, Mach-O)
    toolchain_prefix: arm-none-eabi-   # reader: binutils 일 때만
```

**objects 백엔드가 하는 일** — 각 번역 단위를 compile_commands 플래그 + `-O0 -fno-inline` 으로 컴파일해 `output/<name>/.cache/obj` 에
두고(소스 mtime·플래그로 캐시), ELF 심볼·재배치 테이블에서 함수/데이터 심볼, 호출 재배치(`bl`/`b.w`/`call`), 주소가 취해진 함수(함수 포인터·
테이블·vtable), 데이터 참조를 읽어 이름을 디맹글합니다. 같은 섹션의 static 함수 호출은 어셈블러가 재배치 없이 해결하므로 Thumb/ARM/AArch64/x86
명령을 직접 디코드해 보충합니다. 레지스터·변수의 읽기/쓰기 방향과 가상 호출 대상은 오브젝트에 남지 않으므로, 가장 완전한 설정은 `backend: both` 입니다.
Windows 32/64-bit 모두 Python + `pip install ziglang` 만으로 ARM 트리를 실제로 컴파일합니다(툴체인 설치 불필요).

결과 JSON의 `deep` 섹션에 백엔드·TU 수·정제/추가된 함수 수·캐시 적중·경고가 기록되고, 함수 테이블의 `precise`,
`kind`(function/method/ctor/dtor/template), `cls`, `virtual`, `overrides`, 호출의 `kind`(direct/member/virtual/indirect/ctor)와
후보 `callee_ids`가 채워집니다. `pip install libclang` 하나면 됩니다(DLL 포함). 토큰 파서 자체도 C++(클래스, `Class::method`,
클래스 본문 안의 inline 메서드, 생성자 초기화 리스트, `f<T>(x)`, `obj.method()` 이름 매칭, 테이블·포인터 변수 호출)를 다룹니다.

### 3.3 sw_structure.yaml

```yaml
depth: 3                          # 다이어그램 기본 중첩 깊이
auto_variables: cross_core        # 선언 안 된 전역을 자동 노드로: cross_core | all | none
nodes:                            # 계층. kind는 자유 텍스트(스타일용): subsystem, module, class, struct, shared_memory, group, table, variable
  - id: dlphy
    name: "DL PHY"
    kind: subsystem
    core: 1                       # 자식에게 상속. files를 가진 노드가 "모듈 -> 코어" 매핑을 정의
    note: "..."
    children:
      - { id: dl_pdsch, kind: module, files: ["dl/dl_pdsch.c"],      # files: root 기준 glob -> 그 파일의 모든 함수가 이 노드 소속
          children:
            - { id: pdsch_stages, kind: table, variables: [k_pdsch_stages] } }   # variables: 전역/static/등록 변수 이름
      - { id: hal_fns, kind: module, functions: ["hal_*"] }                     # functions: 함수 이름 glob (공용 파일의 코드용)
  - id: ASA
    kind: struct
    variables: [ASA]
    registered: true              # 소스 밖에서 정의된 변수도 추적
relations:                        # 설계 수준 화살표. kind 자유 텍스트 (uses, dispatch, upcall, produces, consumes ...)
  - { from: dl_pdsch, to: pdsch_stages, kind: dispatch, label: "..." }
touch:                            # "touch"로 인식할 것
  globals: [{ name: ASA, kind: global, note: "..." }]              # 등록 전역 (소스에 정의가 없어도 추적)
  access_macros:                                                    # 접근 매크로
    - { name: ASA_GET, rw: r, var: ASA, field_arg: 0 }              #   ASA_GET(dl.x)      -> read  ASA.dl.x
    - { name: SHM_WR,  rw: w, var_arg: 0, field_arg: 1 }            #   SHM_WR(ASA, ul.y, v) -> write ASA.ul.y
  access_functions:                                                 # 접근 *함수*: 호출 간선 + 변수 접근을 함께 기록
    - { name: shm_write, rw: w, var_arg: 0, field_arg: 1 }          #   shm_write(&g_x, field, v)
    - { name: Mailbox::post, rw: w, var: g_mbox }                   #   고정 변수
  heap_functions: [malloc, calloc, pool_alloc, pool_free]
  ignore_vars: []
  ipc:
    macros: [IPC_SEND, IPC_RECV]
    channel_arg: 0
    channels: [{ id: CH_L1C_TO_DL, from: 0, to: 1 }]
architecture:
  layers: [{ name: ISR, functions: ["*_isr"] }, { name: Driver, functions: ["drv_*"] }]   # 위 -> 아래, 호출은 아래로만
  rules: [{ name: "no heap in ISR", deny: { from: "dl_*", to: "pool_alloc" } }]
  fat_threshold: 8
  allow_skip_layer: true
  include_unreached: false
```

자동 보정: 어떤 노드도 claim하지 않은 파일의 함수는 `<코어> · files without SW node` 박스에, 선언되지 않은 코어 간 공유 전역은
`Shared memory · detected` 박스에 자동으로 들어갑니다(id가 `_auto_`로 시작, 점선 테두리). IPC 화살표는 `touch.ipc`로부터 자동 유도됩니다.

### 3.4 timing.yaml

```yaml
numerology: { mu: 1, symbols_per_slot: 14 }           # symbol_us 로 정확한 CP 길이 지정 가능
cores:                                                # x축 (대각선). 개수 제한 없음
  - { id: 0, name: "Core0 L1C", clock_mhz: 800, description: "..." }
references:                                           # y축 세로 점선. 모두 NW ± offset. kind: ref | sw | hw
  - { id: nw,     name: "NW timing", offset: "0 symbol",    kind: ref }
  - { id: dl_rtg, name: "DL RTG",    offset: "-0.3 symbol", kind: sw }
  - { id: hw_tx,  name: "HW REF TX", offset: "+1.8 symbol", kind: hw }
channels:                                             # y축 채널 할당
  tdd_pattern: "DDDSU"                                # 비우면 FDD (모든 slot이 dl+ul)
  items:
    - { id: PDCCH, dir: dl, symbols: [0, 2],  slots: dl }           # symbols: [start, length]; slots: all|dl|ul|special|[index...]
    - { id: SSB,   dir: dl, symbols: [2, 4],  slots: [0, 1], period_slots: 20, offset_slot: 0 }
isrs:                                                 # z축
  - { name: DL_PDSCH_ISR, core: 1, timing: dl_hi, entry: dl_pdsch_isr,   # timing = reference id, entry = 진입 함수 이름
      start: "13.3 symbol", length: "3.2 symbol", period: "1 slot", priority: 4, description: "..." }
window: { start: "-1 symbol", end: "12 slot" }        # 표시 구간 (NW 기준)
callgraph: { max_depth: 24 }
cost_model:
  source_priority: [trace, config, llm, default]
  trace_file: traces/costs.csv                        # 선택. 열: function,us  또는 function,cycles,clock_mhz
  default_cost: "0.03 symbol"
  external_cost: "0.01 symbol"
  function_costs: { hal_ldpc_wait: "0.5 symbol", "drv_*": "0.04 symbol" }   # 정확한 이름 우선, 그 다음 glob(선언 순서)
```

### 3.5 hw_structure.yaml

```yaml
depth: 2
default_line: hw_ctrl                                 # line을 안 적은 블록의 기준선
macros:
  functions:                                           # 접근 함수: 호출 간선 + 레지스터 접근을 함께 기록
    - { name: hal_fft_start, kind: write, block: FFT, reg: START }
    - { name: hal_reg_write, kind: write, block_arg: 0, reg_arg: 1 }
  read: [HW_RD, HW_POLL]                              # HW_RD(<block>, <reg>)  — block_arg / reg_arg 위치
  write: [HW_WR]
  rmw: [HW_RMW]
  block_arg: 0
  reg_arg: 1
  auto_detect_volatile: true                          # #define 본문에 *(volatile ...) 가 있으면 자동 등록
  custom:                                             # 인자 배치가 다른 매크로
    - { name: REGISTER_READ, kind: read, reg_arg: 0, block_arg: 2 }            # REGISTER_READ(STATUS, , DFE_RX)
    - { name: RXF_WR, kind: write, block: RXF, reg_arg: 0 }                     # 고정 블록
    - { name: REG_WR, kind: write, reg_arg: 0, block_from_reg: "^([A-Z0-9]+)_" } # 레지스터 이름에서 블록 추출
block_aliases: { rxf: DFE_RX }                        # 코드 표기 -> 블록 id (대소문자 무시 매칭도 됨)
nodes:                                                # 계층. regs 또는 base가 있는 노드 = 블록
  - id: rx_chain
    name: "RX chain"
    kind: chain
    children:
      - { id: FFT, name: "FFT", base: 0x50011000, line: hw_rx, regs: [CTRL, SIZE, START, STATUS],
          deadline: { at: "0.5 symbol", period: "1 symbol", note: "..." } }
      - id: RFIC
        regs: [RSSI, RX_GAIN, TX_GAIN]
        deadlines:                                    # 공유 블록: 클라이언트별 데드라인
          - { at: "0.55 symbol", period: "1 symbol", cores: [1] }
          - { timing: hw_tx, at: "0.7 symbol", period: "1 symbol", cores: [2], isrs: [UL_SYMBOL_ISR] }
links:                                                # 데이터 흐름 화살표. kind 자유 텍스트 (data, control, dma)
  - { from: RFIC, to: DFE_RX, kind: data, label: "I/Q" }
```

데드라인 의미: 블록 접근은 그 기준선(`timing`, 기본은 블록의 `line`) 프레임에서 매 `period`마다 `at` 이전에 일어나야 합니다.

### 3.6 annotations.yaml

```yaml
functions: { dl_pdsch_run: "...", "static_fn@file.c": "..." }   # file-static 함수는 name@file.c
blocks:    { LDPC_DEC: "..." }
variables: { g_nw_timing: "..." }
isrs:      { DL_PDSCH_ISR: "..." }
nodes:     { shm: "..." }
```

## 4. 실행

```bash
python -m isrprof list                              # 프로파일 목록
python -m isrprof run <name|디렉터리|profile.yaml>    # 분석 + 뷰어 생성
python -m isrprof run <name> --out-dir <dir> [--no-json] [--fragment frag.html] [-q]
python -m isrprof new <name> [--from <기존 프로파일>]  # 새 프로파일 저장 (템플릿 또는 복제)
python -m isrprof --config legacy.yaml              # 단일 파일 설정 (구형)
```

콘솔 요약: 파싱 통계, ISR별 start/computed/budget/HW 접근/데드라인 미스/OVER BUDGET, 구조 지표, tangle, 위반 목록.

## 5. 결과: 출력 디렉터리

```
output/<name>/
  profile.html             자체 완결 뷰어 (three.js 내장, 오프라인 OK). 브라우저로 열기만 하면 됨
  profile.json             동일 데이터의 JSON (다른 도구와 연동용)
  profile.resolved.yaml    이 결과를 만든 입력 전체를 병합한 사본 (재현용)
  .cache/                  파싱 캐시 (삭제해도 됨)
```

### 5.1 profile.json 구조

| 키 | 내용 |
|---|---|
| `tool`, `project` | 버전, 프로파일 이름, 소스 목록 |
| `build` | root, 파일 수, cmake/빌드 명령, compile_commands 경로, TU 수, defines, include dirs |
| `numerology`, `window` | slot/symbol µs, 표시 구간 |
| `cores[]` | id, name, clock_mhz, 모듈 id 목록 |
| `timing_items[]` | 기준선: id, name, offset_us, kind, priority |
| `channels` | tdd_pattern, items[] (sym_start, sym_len, slots, period_slots ...) |
| `isrs[]` | name, core, timing, entry, start_us, abs_start_us, length_us, period_us, computed_us, over_budget, `tree`(호출 트리: fid, depth, start_us, self_us, total_us, hw_events, via_table, children), `hw_events[]`(t_us, block, reg, kind, deadline_us, violation), `blocks[]`, `functions[]` |
| `functions{fid}` | file, line, core, module(=SW 노드 id), self_us, cost_source, calls[](callee_id / 간접 호출 후보 callee_ids), hw[], vars[](rw, member, via_macro), heap[], ipc[], note |
| `sw_structure` | depth, `nodes[]`(id, name, kind, parent, children, core, functions, variables, implicit), `relations[]`(선언 + derived), `touch{fid: [[node, x\|r\|w\|rw], ...]}`, `fn_node`, `var_node`, `derived_skipped` |
| `hw_structure` | depth, nodes[](block 여부), links[] |
| `hw` | blocks[](regs, line, deadlines, reads/writes/violations, accessors), unknown_blocks[], macros |
| `memory` | variables[](key, kind, cores, shared_across_cores, fields, accessors), heap_users, ipc_ops, ipc_channels |
| `structure` | DSM order/matrix, functions{level, layer, fan_in/out, tangled}, tangles, modules, module_edges, violations, metrics |
| `viewer`, `llm`, `parse_stats` | 뷰어 옵션 사본, LLM 로그, 파싱·전체 소요 ms |

함수 id(`fid`) 규칙: 전역 함수는 이름, file-static 함수는 `이름@파일.c`.

### 5.2 뷰어 사용법 요약

- 위 SW 구조 / 가운데 3D 타이밍 / 아래 HW 구조, 오른쪽 콜그래프·Details. 모든 다이어그램 드래그 이동, 휠 확대.
- 타이밍 다이어그램에서 박스(SW block)나 ISR 행 라벨 클릭 → 포커스. SW 구조에 ■(실행)/r/w, HW 구조에 R/W/✗ 배지.
- 점선: 색 점선은 `timing.yaml`의 `references`(NW ± offset 기준선, 색은 선마다 고정, 범례와 컨트롤의 체크박스에 이름·offset 표시), 빨간 점선은 `hw_structure.yaml` 블록의 데드라인(ISR 인스턴스마다 표시). 컨트롤에서 선별로 끄고 켤 수 있습니다.
- 3D 뷰 이동: 마우스 오른쪽 버튼 드래그 또는 `✥ pan` 버튼을 켠 뒤 왼쪽 드래그, 화살표 버튼 ◀ ▶ ▲ ▼, 키보드 화살표(다이어그램 위에 마우스를 둔 상태). 2D 뷰에서는 같은 조작이 시간 범위 이동 / 행 스크롤입니다.
- 컨트롤: 코어 체크박스, ISR 체크박스 목록(필터, all/none, 코어별 only), Slots(from/count, ◂ ▸, all), Core overlap, 단위, Focus(이 함수만 / leaf까지), 콜그래프 레벨(±, all, entries only, all instances), SW/HW depth, Row scale.
- Details의 항목은 모두 링크입니다. SW 노드 → 포함 내용과 그 함수들이 건드리는 HW 블록, HW 블록 → 그 블록에 대한 모든 접근(시각·레지스터·함수·ISR·데드라인), 공유 변수 → 코어·필드별로 읽고 쓰는 모든 함수, IPC 채널 → 송·수신 함수. 선택할 때마다 다이어그램도 그 함수들로 포커스되며, `◀ back` / `▶`(Alt+← / Alt+→)로 이전 선택으로 돌아갑니다.
- 콜그래프: 선택해도 트리의 최상위는 ISR 진입점으로 유지됩니다(선택 행만 강조·자동 펼침). `pin … as root` 체크박스로 선택 함수를 최상위에 고정한 채 하위를 펼칠 수 있고, ▲ caller / ▼ callee / ◁ ▷ 버튼으로 한 호출씩 이동합니다.
- 모든 창은 아래 모서리를 드래그해 높이를 바꿀 수 있고, 오른쪽 열은 가운데 분할선을 드래그해 너비를 바꿉니다(더블클릭으로 초기화, 브라우저에 기억됨). 세 오버레이는 기본적으로 한 화면(SW 22% / Timing 46% / HW 22%)에 들어오도록 크기가 잡힙니다.
- 딥링크: `#sel-<ISR 또는 함수>`, `#selonly-<함수>`, `#range-0.9~1.3`, `#slots-2~3`, `#isr-A,B`, `#overlap-70`, `#view-3d|tilt|aligned`, `#level-4`, `#swdepth-2`, `#hwdepth-1`, `#structure`, `#selftest`.

## 6. 새 펌웨어 트리에 포팅하는 순서

1. `python -m isrprof new <name> --from nr_modem` 으로 복제한 뒤 `build.yaml`의 `root`/`sources`를 실제 트리로 바꿉니다. 가능하면 CMake에 `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`을 주어 `compile_commands.json`을 연결합니다.
2. `hw_structure.yaml`의 `macros`를 실제 레지스터 접근 매크로에 맞춥니다. 인자 배치가 다르면 `custom`, 블록 이름이 다르면 `block_aliases`. 블록·레지스터·데드라인을 적습니다.
3. `sw_structure.yaml`의 `touch`에 공유 구조체 이름과 접근 매크로, 힙/IPC 프리미티브를 등록합니다. 그 다음 서브시스템 → 모듈(`files`) 계층을 적습니다. 처음에는 모듈 수준까지만 적어도 됩니다.
4. `timing.yaml`에 코어, 기준선, 채널, ISR(진입 함수 이름이 소스의 함수와 일치해야 함)을 적습니다. 비용은 `function_costs`의 glob으로 대략 잡고, 트레이스 CSV가 있으면 `trace_file`로 넣습니다.
5. `python -m isrprof run <name>` 실행 후 콘솔과 뷰어에서 다음을 확인하며 반복합니다.
   - `hw.unknown_blocks` (뷰어 HW 구조의 "not declared" 박스): 매크로/별칭 누락
   - SW 구조의 `files without SW node`, `Shared memory · detected` 박스: 노드/변수 선언 누락
   - ISR 트리에 `ext` 배지가 많으면 함수 정의가 파싱 범위 밖 (`sources`에 추가)
   - `computed`가 모두 default 비용이면 `function_costs`/trace 보강
6. 검증: `python -m unittest discover -s tests`, `python tools/check_js.py`, `python tools/verify_viewer.py output/<name>/profile.html`.

## 6.1 Impact 분석 (Details › Impact)

함수를 선택하면 Details에 Impact 섹션이 나옵니다.
- **Used by**: 직접 호출자, 이 함수에 도달하는 ISR, 이 함수가 쓰는 변수의 소비자 / 읽는 변수의 생산자(ISR·코어·slot 내 시각).
- **Remove**: 제거 시 깨지는 호출자, 어떤 ISR에서도 도달 불가가 되는 함수, 유일한 writer/reader를 잃는 변수, 더는 접근되지 않는 레지스터, ISR 소요 시간 변화(budget 대비).
- **Move to ISR**: 대상 ISR과 위치(처음/끝)를 고르면 서브트리의 레지스터 접근을 새 시각으로 옮겨 데드라인을 다시 검사하고, 공유 변수의 갱신 순서(이 함수의 접근 vs 다른 함수의 접근)가 바뀌는 쌍에 ⚠, 코어가 바뀌어 cross-core가 되는 변수, 대상 ISR budget을 보여줍니다.

## 7. 검증 도구

```bash
python -m unittest discover -s tests          # 39개 테스트: 파이프라인, 프로파일, 파서, C/C++ 코퍼스+랜덤 프로그램, ELF 리더/objects 백엔드(zig 설치 시)
python tools/check_js.py                      # 뷰어 JS 문법
python tools/verify_viewer.py output/<name>/profile.html    # 헤드리스 Edge/Chrome 으로 40단계 self-test (창마다 실제 반응 확인)
python tools/stress.py --programs 30 --viewers 6 --deep clang --out stress_out   # 랜덤 C/C++ 트리 생성 -> 분석 -> HTML -> 뷰어 self-test
python tools/stress.py --programs 8 --viewers 2 --deep both                      # + zig 로 실제 ARM 컴파일 후 ELF 리더로 읽기
```

새 환경에 포팅한 뒤에는 위 순서대로 한 번 돌려 보십시오. `stress.py` 는 코어/ISR/HW 블록/클래스·가상 함수·템플릿·람다·함수 포인터
테이블·접근 매크로·IPC 가 섞인 C/C++ 트리를 무작위로 만들어 전체 파이프라인과 뷰어를 검증하고 `stress_report.json` 을 남깁니다.

## 8. 알아둘 제약

- 내장 파서는 전처리를 하지 않는 토큰 파서입니다. `#if`로 꺼진 코드도 파싱되고, 매크로로 생성되는 함수는 `ISR_ENTRY(name)` 같은 **대문자 매크로(이름) { ... }** 형태만 인식합니다. 전처리가 꼭 필요하면 `parser.backend: libclang` 플러그인을 붙이십시오.
- 지역 변수는 매개변수와 `타입 이름 [= ...];` 꼴의 선언을 수집해 전역 접근에서 제외합니다. 매크로로 선언되는 지역 변수처럼 이 꼴을 벗어나면 전역과 같은 이름일 때 오탐이 생길 수 있습니다 (`touch.ignore_vars`로 제외 가능).
- 간접 호출(`tbl[i].run(ctx)`)은 같은 파일의 파일 스코프 초기화 테이블에 등장하는 함수들을 후보로 전개합니다. 다른 파일의 테이블은 따라가지 않습니다.
- 레지스터 접근 시각은 함수 self 비용을 이벤트 순서로 균등 분할한 보간값입니다. 정확한 타이밍은 트레이스 비용을 넣을수록 좋아집니다.
- 대형 트리: 1,000 파일/4,200 함수 기준 분석 약 2초, 뷰어 조작 50~300 ms. 유도 IPC 화살표는 400개까지만 그립니다.
