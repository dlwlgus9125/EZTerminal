import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecureAtomicFile, type SecureAtomicFileOptions } from './secure-atomic-file';
import type { ChatStateStoreOptions } from './chat-state-store';

type Protector = ChatStateStoreOptions['protector'];
const PREFIX = Buffer.from('EZREC1');
const KEY_SCRIPT = `Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($request.data)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($request.operation -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
} else {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($result))`;

/** One OS operation per app launch; message content never crosses this pipe. */
function protectWindowsKey(operation: 'protect' | 'unprotect', bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', KEY_SCRIPT],
      { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new Error('Windows could not unlock secure draft storage.')); return; }
        const value = stdout.trim(); const result = Buffer.from(value, 'base64');
        if (!value || result.toString('base64') !== value) reject(new Error('Windows returned an invalid protected key.'));
        else resolve(result);
      });
    child.stdin?.on('error', () => reject(new Error('Windows secure storage is unavailable.')));
    child.stdin?.end(JSON.stringify({ operation, data: bytes.toString('base64') }));
  });
}

/**
 * Chromium can defer its first Local State key write beyond a quick app exit.
 * Persist our DPAPI-wrapped key atomically before acknowledging any draft save.
 * Existing Electron ciphertext remains readable through the legacy protector.
 */
export function createDesktopRecoveryProtector(directory: string, legacy: Protector, options: SecureAtomicFileOptions & {
  readonly protectKey?: typeof protectWindowsKey;
} = {}): Protector {
  if ((options.platform ?? process.platform) !== 'win32') return legacy;
  const file = new SecureAtomicFile(directory, 'recovery-key-v1.bin', { ...options, maxBytes: 16_384 });
  const protectKey = options.protectKey ?? protectWindowsKey;
  let pendingKey: Promise<Buffer> | undefined;
  const key = (): Promise<Buffer> => {
    if (!pendingKey) pendingKey = (async () => {
      await file.init();
      return file.enqueue(async () => {
        const saved = await file.readText();
        if (saved !== undefined) {
          const wrapped = Buffer.from(saved, 'base64');
          if (!saved || wrapped.toString('base64') !== saved) throw new Error('The protected draft key is invalid.');
          const restored = await protectKey('unprotect', wrapped);
          if (restored.length !== 32) throw new Error('The protected draft key is invalid.');
          return restored;
        }
        const created = randomBytes(32);
        const wrapped = await protectKey('protect', created);
        if (wrapped.length === 0) throw new Error('Windows did not protect the draft key.');
        await file.writeAtomic(wrapped.toString('base64'));
        return created;
      });
    })().catch(error => { pendingKey = undefined; throw error; });
    return pendingKey;
  };
  return {
    available: () => true,
    encrypt: async plaintext => {
      const secret = await key();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, nonce);
      cipher.setAAD(PREFIX);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([PREFIX, nonce, cipher.getAuthTag(), ciphertext]);
    },
    decrypt: async ciphertext => {
      if (!ciphertext.subarray(0, PREFIX.length).equals(PREFIX)) return legacy.decrypt(ciphertext);
      if (ciphertext.length < PREFIX.length + 28) throw new Error('Encrypted draft data is incomplete.');
      const decipher = createDecipheriv('aes-256-gcm', await key(), ciphertext.subarray(PREFIX.length, PREFIX.length + 12));
      decipher.setAAD(PREFIX);
      decipher.setAuthTag(ciphertext.subarray(PREFIX.length + 12, PREFIX.length + 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(PREFIX.length + 28)), decipher.final()]).toString('utf8');
    },
  };
}
