/**
 * Chrome bands above and below the visible chat transcript, evaluated inside
 * the Android WebView (Chrome 74 floor: no optional chaining, no `??`, no
 * String#replaceAll). Mirrors scripts/chrome-bands.mjs for the ux2 baseline.
 */
export const CHROME_BANDS_PROBE = `(() => {
  function visible(element) {
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  var transcript = Array.prototype.slice.call(document.querySelectorAll('.chat-transcript')).filter(visible)[0];
  if (!transcript) return null;
  var t = transcript.getBoundingClientRect();
  function describe(element) {
    var rect = element.getBoundingClientRect();
    var className = typeof element.className === 'string' ? element.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return {
      element: element.tagName.toLowerCase() + (className ? '.' + className : ''),
      testid: element.getAttribute('data-testid') || undefined,
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      text: (element.innerText || '').split(/\\s+/).join(' ').trim().slice(0, 60)
    };
  }
  var above = [];
  var below = [];
  for (var node = transcript; node && node.parentElement && node !== document.body; node = node.parentElement) {
    var siblings = node.parentElement.children;
    for (var index = 0; index < siblings.length; index += 1) {
      var sibling = siblings[index];
      if (sibling === node || !visible(sibling)) continue;
      var rect = sibling.getBoundingClientRect();
      if (rect.height < 4 || rect.width < t.width * 0.4) continue;
      if (rect.right <= t.left || rect.left >= t.right) continue;
      if (rect.bottom <= t.top + 1) above.push(describe(sibling));
      else if (rect.top >= t.bottom - 1) below.push(describe(sibling));
    }
  }
  var strips = document.querySelectorAll('.dv-tabs-and-actions-container');
  for (var s = 0; s < strips.length; s += 1) {
    var strip = strips[s];
    if (!visible(strip)) continue;
    var stripRect = strip.getBoundingClientRect();
    if (stripRect.right <= t.left || stripRect.left >= t.right || stripRect.bottom > t.top + 1) continue;
    above.push(describe(strip));
  }
  above.sort(function (a, b) { return a.top - b.top; });
  below.sort(function (a, b) { return a.top - b.top; });
  return {
    window: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio },
    transcript: { top: Math.round(t.top), bottom: Math.round(t.bottom), height: Math.round(t.height), width: Math.round(t.width) },
    transcriptShare: Number((t.height / innerHeight).toFixed(3)),
    chromeAbovePx: Math.round(t.top),
    chromeBelowPx: Math.round(innerHeight - t.bottom),
    above: above,
    below: below
  };
})()`;
