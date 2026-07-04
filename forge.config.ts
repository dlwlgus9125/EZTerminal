import path from 'node:path';
import { cpSync, readFileSync, realpathSync } from 'node:fs';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// B-M3: code-signing infrastructure, env-gated so builds stay UNSIGNED until a
// certificate exists (acquisition is an external/user decision —
// docs/release/signing.md). Set WINDOWS_SIGN_CERT_FILE (path to .pfx) and
// WINDOWS_SIGN_CERT_PASSWORD to activate; the exe/dlls (packager) and
// Setup.exe (Squirrel) sign with the same options. signtool.exe is vendored
// by @electron/windows-sign — no Windows SDK required.
const windowsSign = process.env.WINDOWS_SIGN_CERT_FILE
  ? {
      certificateFile: process.env.WINDOWS_SIGN_CERT_FILE,
      certificatePassword: process.env.WINDOWS_SIGN_CERT_PASSWORD,
      description: 'EZTerminal',
    }
  : undefined;

/**
 * Recursively copy a production dependency (realpath-resolved, dereferencing
 * pnpm's symlinks) plus every package named in ITS OWN `package.json`
 * `dependencies` — into `buildPath/node_modules/<name>`, flat (never nested
 * inside another copied package's own node_modules). This is how Node's
 * resolution walk finds them regardless: `require('asn1')` from inside
 * `node_modules/ssh2/lib/...` walks up to `node_modules/` and finds it there,
 * the same shape a hoisted install would produce. `deprecated`/`optional`
 * dependencies (e.g. ssh2's `cpu-features`/`nan`) are deliberately NOT
 * followed — only `dependencies` (design §7.3, Option B: ssh2 stays pure-JS,
 * those native accelerators are never built and ssh2 already tolerates their
 * absence). `copied` dedupes a package reachable via more than one path.
 */
function copyProdDepTree(name: string, buildPath: string, copied: Set<string>): void {
  if (copied.has(name)) return;
  copied.add(name);
  const src = realpathSync(path.join(process.cwd(), 'node_modules', name));
  const dest = path.join(buildPath, 'node_modules', name);
  cpSync(src, dest, { recursive: true, dereference: true });
  let dependencies: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    dependencies = pkg.dependencies ?? {};
  } catch {
    // No/unreadable package.json — nothing further to recurse into.
  }
  for (const dep of Object.keys(dependencies)) copyProdDepTree(dep, buildPath, copied);
}

const config: ForgeConfig = {
  // Env-gated output override (default stays `out/`). Exists because a stale
  // handle from another session can EBUSY-lock out/EZTerminal-win32-x64,
  // which packager must rmdir — set EZ_OUT_DIR to package somewhere else.
  outDir: process.env.EZ_OUT_DIR,
  packagerConfig: {
    windowsSign,
    // App identity (B-M1). icon.ico is a generated PLACEHOLDER until real art
    // lands — regenerate with `node scripts/generate-placeholder-icon.mjs`.
    // electron-packager embeds it into the exe via rcedit, so `pnpm package`
    // fails loudly if the .ico is malformed.
    icon: './assets/icon',
    appCopyright: `Copyright © ${new Date().getFullYear()} EZTerminal`,
    win32metadata: {
      CompanyName: 'EZTerminal',
      ProductName: 'EZTerminal',
      FileDescription: 'EZTerminal — a structured-data shell terminal',
    },
    // asar with an explicit unpack for the entire node-pty native module.
    // node-pty (Phase 2 PTY/TUI support) loads NAPI `.node` addons from
    // prebuilds/<platform>-<arch>/ AND fork()s internal JS workers + may load
    // ConPTY helper binaries (conpty.dll / OpenConsole.exe) by real filesystem
    // path — none of which can run from inside app.asar. AutoUnpackNativesPlugin
    // only unpacks `*.node`, so the workers/helpers would stay trapped. Unpacking
    // the whole module is the robust fix (verified post-package by `guard:native`).
    // The AutoUnpackNatives plugin merges its `*.node` glob with this one.
    //
    // ssh2 (E5) is pure-JS and would run fine PACKED — Electron's own require()
    // is asar-transparent. It is unpacked anyway for a narrower reason: the
    // packaged-module smoke test (e2e-packaged/ssh-packaged.spec.ts, gate B4)
    // requires it from a PLAIN Node process (no Electron asar patch), which can
    // only read real files. Its whole prod-dependency closure must be unpacked
    // too (asn1, bcrypt-pbkdf, and THEIR deps tweetnacl/safer-buffer) — they are
    // copied as FLAT siblings under node_modules by `copyProdDepTree` below, so
    // Node's directory-walk-up resolution finds them once all five are unpacked
    // to the same app.asar.unpacked/node_modules/. Keep this list in sync with
    // ssh2's transitive `dependencies` (checked at install time, 2026-07-03).
    // cap (Phase 2B packet capture) joins the unpack set for the same reason
    // as node-pty: it loads a NAPI-less classic `.node` addon by real
    // filesystem path (and, at load time, Windows' wpcap.dll from Npcap), so
    // it cannot run from inside app.asar. guard-native-cap.mjs verifies this.
    asar: {
      unpack: '**/node_modules/{node-pty,ssh2,asn1,bcrypt-pbkdf,tweetnacl,safer-buffer,cap}/**',
    },
  },
  // `ignoreModules` — this rebuild hook had never actually run to completion
  // in this repo before cap made it do real work; two PRE-EXISTING, unrelated
  // gaps surfaced the moment it did (verified by running `pnpm start` before
  // vs. after this option):
  //  - cpu-features: ssh2's OPTIONAL native accelerator (design §7.3, Option B:
  //    ssh2 stays pure-JS, deliberately never built). Its own gyp setup is
  //    incomplete on a plain `pnpm install` (build script never runs), so
  //    @electron/rebuild's default walk — 'prod' AND 'optional' deps — fails
  //    trying to rebuild it.
  //  - node-pty: ships NAPI prebuilds specifically so it is ABI-agnostic and
  //    needs NO per-Electron-version rebuild (confirmed project history); its
  //    from-source path (deps/winpty's `GetCommitHash.bat`) is broken in this
  //    environment and was never meant to run here.
  // Both are pre-existing gaps this hook exposes, not new ones cap introduces.
  rebuildConfig: { ignoreModules: ['cpu-features', 'node-pty'] },
  hooks: {
    // Forge + Vite packages ONLY the Vite bundles (.vite/ + package.json) — it
    // ships no node_modules. node-pty is a native module we externalize from the
    // interpreter bundle, so without this it is absent at runtime and
    // `require('node-pty')` throws only in the packaged exe. Copy the real module
    // (dereferencing pnpm's symlink) into the packaged app's node_modules so the
    // interpreter resolves it; `asar.unpack` then keeps its native binaries +
    // forked JS workers on disk (app.asar.unpacked). Verified by `guard:native`.
    // `.pdb` debug symbols are skipped (never loaded at runtime, ~30MB).
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      const src = realpathSync(path.join(process.cwd(), 'node_modules', 'node-pty'));
      const dest = path.join(buildPath, 'node_modules', 'node-pty');
      cpSync(src, dest, {
        recursive: true,
        dereference: true,
        // Skip debug symbols, the winpty SOURCE tree (deps/ — build-time only;
        // its misc/*.ps1 also break signing: signtool can't append-sign ps1),
        // and foreign-platform prebuilds: dead weight (darwin/linux Mach-O/ELF
        // in a Windows package) that signtool walks in app.asar.unpacked and
        // cannot sign (B-M3). Runtime needs lib/ + prebuilds/<platform>-*/ +
        // third_party/ only; guard:native keeps this honest.
        filter: (s) => {
          if (s.endsWith('.pdb')) return false;
          if (/[\\/]deps([\\/]|$)/.test(s)) return false;
          const prebuild = s.match(/[\\/]prebuilds[\\/]([^\\/]+)/);
          return prebuild === null || prebuild[1].startsWith(`${process.platform}-`);
        },
      });

      // ssh2 (E5, Option B — design §7.3): externalized from the interpreter
      // bundle (vite.interpreter.config.ts) but, like node-pty, absent from
      // the packaged node_modules unless copied here. Recursively pulls in its
      // prod-dependency closure (asn1, bcrypt-pbkdf, tweetnacl, safer-buffer) as
      // flat node_modules siblings; see the `asar.unpack` comment above for why
      // this whole set — despite being pure-JS — is unpacked too.
      copyProdDepTree('ssh2', buildPath, new Set());

      // cap (Phase 2B packet capture): same problem as node-pty above — Forge
      // + Vite ships no node_modules, and cap is externalized from the
      // packet-capture-host bundle (vite.packet-capture.config.ts), so without
      // this copy `require('cap')` would throw only in the packaged exe.
      // Unlike ssh2, cap's only declared dependency (nan) is a build-time-only
      // C++ header lib never `require()`d at runtime, so a plain
      // self-contained copy suffices (no copyProdDepTree needed). `deps/
      // winpcap` (the WinPcap SDK headers/import libs `cap`'s binding.gyp
      // links against) is build-time-only and skipped — same rationale as
      // node-pty's `deps/` (winpty source) exclusion above.
      const capSrc = realpathSync(path.join(process.cwd(), 'node_modules', 'cap'));
      const capDest = path.join(buildPath, 'node_modules', 'cap');
      cpSync(capSrc, capDest, {
        recursive: true,
        dereference: true,
        filter: (s) => {
          if (s.endsWith('.pdb')) return false;
          if (/[\\/]deps[\\/]winpcap([\\/]|$)/.test(s)) return false;
          return true;
        },
      });
    },
  },
  makers: [
    // Squirrel.Windows installer (B-M1). `noMsi` — Squirrel's MSI is a legacy
    // machine-wide stub, not the real installer; the Setup.exe is canonical.
    // `iconUrl` must be a remote URL (Squirrel constraint) — points at the repo
    // raw path once a GitHub remote exists; until then Add/Remove Programs
    // falls back to a generic icon (setup/app icons are unaffected).
    new MakerSquirrel({
      authors: 'EZTerminal',
      description: 'EZTerminal — a structured-data shell terminal',
      setupExe: 'EZTerminal-Setup.exe',
      setupIcon: path.join(process.cwd(), 'assets', 'icon.ico'),
      noMsi: true,
      windowsSign,
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` specifies the Node-side entry builds (main process, preload,
      // and the interpreter utilityProcess). Each gets its own CJS bundle.
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        // Interpreter utilityProcess: separate Node CJS bundle so main can
        // fork it via utilityProcess.fork(). target:'main' gets Node externals.
        {
          entry: 'src/interpreter/interpreter-process.ts',
          config: 'vite.interpreter.config.ts',
          target: 'main',
        },
        // Script-host utilityProcess (E4): forked by main per `run-script`
        // invocation (C1/C2 — the interpreter cannot fork one itself).
        {
          entry: 'src/script-host/script-host.ts',
          config: 'vite.script-host.config.ts',
          target: 'main',
        },
        // Packet-capture utilityProcess (Phase 2B): forked by main per
        // `packets:subscribe`, same reason a script-host is — only main can
        // fork a utilityProcess. Loads `cap` (Npcap) to header-only-capture
        // live packets and streams them to the renderer over a MessagePort.
        {
          entry: 'src/packet-capture/packet-capture-host.ts',
          config: 'vite.packet-capture.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
