// jsdom deliberately leaves canvas rendering unimplemented. xterm probes for a
// 2D context at module-load time and supports a null result, but jsdom emits a
// noisy "not implemented" error before returning null. Model the browser API's
// supported fallback directly so real test failures remain visible on stderr.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
});
