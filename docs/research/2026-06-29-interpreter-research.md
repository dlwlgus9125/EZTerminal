# EZTerminal 셸 코어(인터프리터) 리서치 결과 (2026-06-29)

> deep-research 2차(집중) 산출. 5각도, 23소스, 112 claims → 25 검증 시도.
> ⚠️ **부분 완료:** 워크플로우가 **월 사용량(spend) 한도**에 걸려 합성 단계 + 7개 검증이 중단됨.
> **18개 claim은 검증 통과**(아래). 7개는 기권(미검증) — 표기함. 합성은 메인 에이전트가 직접 수행.

---

## 결론 — 셸 코어 아키텍처 (잠금 가능)

| 레이어 | 권고 | 근거 |
|---|---|---|
| **파서** | **Chevrotain** (파서 콤비네이터/툴킷, TS-native) | F-P1~P5 |
| **값 모델** | Nushell식 `list` / `record` / `table` (1차 리서치 F1) | (이전 문서) |
| **파이프라인** | 통합 PipelineData형: `Value`(materialized) \| `ListStream`(lazy) \| `ByteStream`(외부/텍스트) | F-S1~S2 (+미검증 패턴) |
| **명령 시그니처** | Nushell식 입력→출력 계약 + 타입 인자 + 플래그/위치 | F-C1~C3 |
| **명령 레지스트리/디스패치** | Zod 검증 선언형 API (zli/cmd-ts 패턴) | F-C4~C8 |
| **평가자** | AST 트리워킹 + 스코프/환경 (ts-evaluator 참고) | F-E1 |
| **REPL/대화 루프** | **node:repl 아님** → React 블록 UI 입력. 자동완성은 Chevrotain `computeContentAssist` | F-P4 + 설계 |

---

## Area 1 — 파싱: Chevrotain 권고

- **F-P1 (3-0):** Chevrotain은 **코드 생성 없는** 파서 툴킷 — 문법을 JS/TS 내부 DSL로 작성. 별도 생성/빌드 단계 없음(peggy 같은 PEG 생성기와 차별). 출처: https://chevrotain.io/
- **F-P2 (2-1):** 성능이 다른 JS 파싱 라이브러리보다 several times 빠르고 수작업 파서와 경쟁 가능.
- **F-P3 (3-0):** **내장 error-recovery 휴리스틱** — 부분적으로 유효하지 않은 입력도 파싱. REPL의 에러 복구/부분 파싱 요구 직접 충족.
- **F-P4 (3-0):** **내장 구문 자동완성 API** `parserInstance.computeContentAssist(startRule, partialTokens)` — 문법 변경 0으로 REPL 자동완성 연결. 출처: https://chevrotain.io/docs/guide/syntactic_content_assist.html
- **F-P5 (3-0):** ⚠️ computeContentAssist는 **구문상 유효한 다음 토큰**만 계산. 의미 기반 제안(컬럼명·심볼 등)은 그 위에 직접 구현.
- (참고) Optique: optparse-applicative+Zod에서 영감받은 **타입 안전 조합형 파서** — 콤비네이터 접근 검증(F-C7~C8). 다만 풀 파이프 문법보다 CLI 인자 파싱에 가까움.
- **판단:** Chevrotain = 수작업 재귀하강의 통제력 + 에러복구/자동완성 내장 + TS-native. 1차 파서로 채택. (수작업은 더 단순하지만 자동완성/에러복구를 직접 다 만들어야 함.)

## Area 2 — 파이프라인 실행 (Nushell 스트리밍 차용)

- **F-S1 (3-0):** Nushell은 `ExternalStream`을 **`ByteStream`**(Read 가능한 바이트 스트림)으로 교체. 소스 enum = `{ Read(임의), File, Child(자식 프로세스) }`. 출처: https://github.com/nushell/nushell/pull/12774
- **F-S2 (3-0):** 이전 `RawStream`(`Iterator<Vec<u8>>`)은 청크마다 힙 할당 → ByteStream으로 **청크별 할당 제거**(메모리 압박 감소).
- ✅ **재검증 완료(WebFetch, 2026-06-29):** `PipelineData = Value | ListStream(lazy) | ByteStream` — DeepWiki 원문 "PipelineData is the foundational abstraction for input and output to commands. It represents either a single `Value` or a stream of values." ByteStream=외부/IO, ListStream="lazy stream of Value items" 확인. (이전 spend 한도 기권 → CONFIRMED로 전환.) **EZTerminal 매핑:** 네이티브 구조화 = Value/ListStream, 외부 child_process 텍스트 = ByteStream.
- **판단:** 스트리밍 가능 통합 파이프라인 타입 채택. 큰 출력/조기종료/Ctrl+C는 lazy iterator(제너레이터/AsyncIterable)로.

## Area 3 — 명령 시그니처 & 디스패치

- **F-C1 (3-0):** Nushell 명령은 **입력→출력 파이프라인 타입 계약**을 시그니처에 명시: `def "str stats" []: string -> record { }`. 여러 입출력 쌍 가능. 출처: https://www.nushell.sh/book/custom_commands.html
- **F-C2 (3-0):** 파라미터에 고정 타입 어휘(any/bool/int/float/string/list/record/**table**/filesize/duration…) 정적 주석.
- **F-C3 (3-0):** 플래그(`--age`, 단축 `-a`, boolean 스위치) vs 위치 인자 구분, 바인딩 변수명은 long 플래그에서 유도.
- **F-C4~C5 (3-0):** **cmd-ts** — 커스텀 인자 타입이 raw 문자열을 검증된 타입 값으로 디코드. `Type<In,Out>` 인터페이스 + async `from()` 검증/변환. 출처: https://github.com/Schniz/cmd-ts
- **F-C6 (3-0):** cmd-ts `command()` 팩토리가 `positional()`/`option()`에 타입 디코더 매핑 — 선언형 타입 시그니처 패턴.
- **F-C7 (3-0):** **zli** — `defineCommand()`(description/options/args/action), options/args는 **Zod 스키마**, action은 검증된 타입 옵션 수신. 출처: https://github.com/robingenz/zli
- **F-C8 (2-0):** zli **레지스트리+디스패치 분리**: `defineConfig()`로 commands 맵 등록, `processConfig(config, args)`가 argv 파싱→매칭 명령+검증 인자 반환.
- **판단:** Nushell식 시그니처(입력→출력 + 타입 인자 + 플래그/위치)를 **Zod 검증 선언형 레지스트리**(zli 패턴)로 TS 구현.

## Area 4 — 트리워킹 인터프리터

- **F-E1 (2-0):** **ts-evaluator** = 트리워킹 인터프리터 — AST의 Node를 그 **렉시컬 환경**으로 평가(전체 프로그램 컴파일 아님). 출처: https://github.com/wessberg/ts-evaluator
- **판단:** 표준 구조 — 렉서(Chevrotain 토큰) → 파서(Chevrotain) → AST(파이프라인/명령/표현식 노드) → 트리워킹 평가자(스코프/환경 보유). 참고 블로그: tomassetti.me/parsing-in-javascript, thunderseethe.dev/posts/parser-base.

## Area 5 — REPL/대화 환경 (⚠️ 미검증 — 단 대부분 무의미)

- ✅ **재검증 완료(WebFetch, 2026-06-29):** `node:repl`의 커스텀 eval `(code, context, replResourceName, callback)`, 멀티라인용 `repl.Recoverable` 반환, `completer` 자동완성 옵션 — **모두 CONFIRMED**(Node 공식 docs). 단 아래 "중요" 참고로 우리는 직접 안 씀.
- **중요:** EZTerminal의 "REPL"은 **node:repl이 아니라 React 블록 UI 입력**임(블록 UI 결정). node:repl은 터미널 CLI용 → 이 프로젝트엔 부적합/불필요. 따라서 이 영역 미검증은 아키텍처에 영향 적음.
- 멀티라인/히스토리/구문강조/자동완성은 **React 입력 컴포넌트 + Chevrotain computeContentAssist(F-P4)**로 처리.

---

## 기각/재검증 정리
- Optique 컴파일타임 타입 추론(1-0): 근거 부족 → 기각 유지.
- node:repl 3건 + PipelineData 3건: 원래 spend 한도로 0-0 기권 → **2026-06-29 WebFetch로 재검증 완료, 6건 모두 CONFIRMED** (위 Area 2 / Area 5 반영).

## 남은 작업
- ✅ 미검증 6건 재검증 완료.
- ⏳ Codex 아키텍처 검증(프로세스 경계·스트리밍 IPC·파서 선택 등) 결과 반영 → 셸 코어 설계 잠금 → 빌드.
