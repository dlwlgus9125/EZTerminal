import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Android secure-storage patch', () => {
  it('removes a named entry without decrypting it first', () => {
    const source = readFileSync(resolve(
      root,
      'node_modules/capacitor-secure-storage-plugin/android/src/main/java/com/whitestein/securestorage/SecureStoragePluginPlugin.java',
    ), 'utf8');
    const removeMethod = source.slice(
      source.indexOf('public void remove(PluginCall call)'),
      source.indexOf('public void clear(PluginCall call)'),
    );

    expect(removeMethod).toContain('call.resolve(this._remove(key));');
    expect(removeMethod).not.toContain('this.has(key)');
  });
});
