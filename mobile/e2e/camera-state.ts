/**
 * Parses the stable CameraService sections used by the QR lifecycle gate.
 *
 * A missing HAL, zero devices, or an unfamiliar dump shape is not equivalent
 * to an inactive app camera: those states make release evidence unobservable
 * and must fail closed instead of producing a false pass.
 */
export function parseAppCameraClientActive(
  cameraDump: string,
  appId: string,
): boolean {
  if (!appId.trim()) throw new Error('Camera client parsing requires a non-empty app id.');
  if (/CameraService may be deadlocked/u.test(cameraDump)) {
    throw new Error('CameraService reported that its state may be deadlocked.');
  }

  const deviceCountMatch = cameraDump.match(
    /^[ \t]*Number of camera devices:\s+([0-9]+)\s*$/mu,
  );
  const deviceCount = Number(deviceCountMatch?.[1]);
  if (
    !deviceCountMatch
    || !Number.isSafeInteger(deviceCount)
    || deviceCount <= 0
  ) {
    throw new Error('CameraService did not report an available camera device.');
  }

  const activeSectionMatch = cameraDump.match(
    /^[ \t]*Active Camera Clients:\s*([\s\S]*?)^[ \t]*Allowed user IDs:/mu,
  );
  if (!activeSectionMatch) {
    throw new Error('CameraService did not expose its active-client section.');
  }

  const escapedAppId = appId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(
    `(^|[^A-Za-z0-9_.])${escapedAppId}(?=[^A-Za-z0-9_.]|$)`,
    'u',
  ).test(activeSectionMatch[1]);
}
