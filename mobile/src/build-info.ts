import mobilePackage from '../package.json';
import releaseContract from '../../release/version.json';

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

/** Android's monotonic package build number from the same release contract Gradle consumes. */
export const MOBILE_ANDROID_VERSION_CODE = releaseContract.androidVersionCode;
