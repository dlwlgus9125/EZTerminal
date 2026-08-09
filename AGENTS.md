# Project validation

## UI design workflow

- UI를 설계하거나 변경하기 전에 루트 [`DESIGN.md`](DESIGN.md),
  [`docs/ux/frontend-design.md`](docs/ux/frontend-design.md), 관련 production
  Storybook story와 component 순서로 읽는다.
- `DESIGN.md`는 visual identity와 판단 기준, frontend UX 계약은 정보 구조·flow·state·
  responsive·accessibility, theme/token source는 정확한 runtime 값을 소유한다. 같은
  규칙이나 값을 두 문서에 복사하지 않는다.
- 고정 desktop handoff 원본은 수정하지 않으며 snapshot은 reference와 나란히 검토한
  경우에만 갱신한다.

- Ordinary development validation uses `pnpm e2e`; the release performance
  benchmark is excluded from that command.
- Do not run `pnpm e2e:performance`,
  `e2e/release-performance.spec.ts`,
  set `EZTERMINAL_RUN_RELEASE_PERFORMANCE=1`, or pass
  `-RunPerformanceMeasurement` unless the user explicitly asks for a
  performance measurement (for example, "성능 측정해줘" or
  "성능측정 해줘").
- A request to build, test, update, package, or release by itself is not
  permission to run the performance benchmark.
