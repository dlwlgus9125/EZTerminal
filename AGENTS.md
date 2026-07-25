# Project validation

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
