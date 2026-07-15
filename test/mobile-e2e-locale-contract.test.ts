import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('physical mobile E2E locale contract', () => {
  it('uses stable test ids for pairing and the physical smoke path', () => {
    const library = readFileSync(path.join(root, 'mobile/e2e/lib.ts'), 'utf8');
    const smoke = readFileSync(path.join(root, 'mobile/e2e/smoke.ts'), 'utf8');
    const parity = readFileSync(path.join(root, 'mobile/e2e/parity.ts'), 'utf8');

    expect(library).toContain("waitForTestId('connect-screen', 45_000)");
    expect(library).toContain("tapTestId('connect-submit')");
    expect(library).toContain("['mobile-workspace', 'connect-error', 'connect-protocol-incompatible']");
    expect(library).toContain("tapTestId('tab-add-btn')");
    expect(library).not.toContain("waitForText('Connect')");
    expect(smoke).toContain('createTerminalSession()');
    expect(smoke).toContain("tapTestId('btn-run')");
    expect(smoke).not.toContain('waitForText(');
    expect(parity).toContain("tapTestId('stats-tab-capture')");
    expect(parity).toContain("tapTestId('status-packet-ack-confirm')");
    expect(parity).not.toContain('waitForText(');
    expect(parity).not.toContain("node.text === 'Downloads'");
  });
});
