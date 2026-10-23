/*
 * Measures the horizontal chrome bands stacked above and below the visible
 * chat transcript: header, workbench bar, dock tabs, chat header, composer,
 * status bar... Runs inside the page (page.evaluate), so it must stay
 * self-contained. Used for the ux2 journey baseline and later gate checks.
 */
export function measureChromeBands() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const transcript = [...document.querySelectorAll('.chat-transcript')].find(visible);
  if (!transcript) return null;
  const t = transcript.getBoundingClientRect();
  const describe = (element) => {
    const rect = element.getBoundingClientRect();
    const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/u).slice(0, 2).join(' ') : '';
    return {
      element: `${element.tagName.toLowerCase()}${className ? `.${className.replaceAll(' ', '.')}` : ''}`,
      testid: element.getAttribute('data-testid') ?? undefined,
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      text: (element.innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60),
    };
  };
  const above = [];
  const below = [];
  for (let node = transcript; node?.parentElement && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || !visible(sibling)) continue;
      const rect = sibling.getBoundingClientRect();
      if (rect.height < 4 || rect.width < t.width * 0.4) continue;
      if (rect.right <= t.left || rect.left >= t.right) continue;
      if (rect.bottom <= t.top + 1) above.push(describe(sibling));
      else if (rect.top >= t.bottom - 1) below.push(describe(sibling));
    }
  }
  // Dockview renders panel content in an overlay layer, so the dock tab strip
  // is not an ancestor's sibling of the transcript: find it by geometry.
  for (const strip of document.querySelectorAll('.dv-tabs-and-actions-container')) {
    if (!visible(strip)) continue;
    const rect = strip.getBoundingClientRect();
    if (rect.right <= t.left || rect.left >= t.right || rect.bottom > t.top + 1) continue;
    if (above.some((band) => band.top === Math.round(rect.top))) continue;
    // Only the strip of the group that holds the transcript (closest above it).
    const holder = above.find((band) => band.element.includes('dv-tabs'));
    if (holder && holder.top > rect.top) continue;
    if (holder) above.splice(above.indexOf(holder), 1);
    above.push(describe(strip));
  }
  above.sort((a, b) => a.top - b.top);
  below.sort((a, b) => a.top - b.top);
  return {
    window: { width: innerWidth, height: innerHeight, devicePixelRatio },
    transcript: { top: Math.round(t.top), bottom: Math.round(t.bottom), height: Math.round(t.height), width: Math.round(t.width) },
    transcriptShare: Number((t.height / innerHeight).toFixed(3)),
    chromeAbovePx: Math.round(t.top),
    chromeBelowPx: Math.round(innerHeight - t.bottom),
    above,
    below,
  };
}
