import mobilePackage from '../package.json';

import {
  REMOTE_PROTOCOL_VERSION,
  type BuildInfo,
} from '../../src/shared/remote-protocol';

/** Build identity shared by the handshake, Settings, and copied diagnostics. */
export const MOBILE_BUILD_INFO: BuildInfo = Object.freeze({
  appVersion: mobilePackage.version,
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  buildSha: import.meta.env.VITE_BUILD_SHA?.trim() || 'dev',
});
