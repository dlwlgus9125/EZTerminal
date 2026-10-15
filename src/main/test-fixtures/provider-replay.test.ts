import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_GOLDEN_DIRECTORY,
  listProviderCaptureFixtures,
  readProviderCaptureFixture,
  replayProviderFixture,
} from './provider-replay';

// UPDATE_PROVIDER_GOLDENS=1 rewrites src/renderer/chat/fixtures from the
// recorded provider traffic; otherwise the committed goldens are the contract.
const updateGoldens = process.env.UPDATE_PROVIDER_GOLDENS === '1';

describe('recorded provider sessions replayed through the current adapters', () => {
  const fixtures = listProviderCaptureFixtures();

  it('has recorded fixtures to replay', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    it(`${name} matches its golden transcript`, async () => {
      const golden = await replayProviderFixture(readProviderCaptureFixture(name));
      const target = path.join(PROVIDER_GOLDEN_DIRECTORY, `${name}.json`);
      const serialized = `${JSON.stringify(golden, null, 2)}\n`;
      if (updateGoldens) {
        mkdirSync(PROVIDER_GOLDEN_DIRECTORY, { recursive: true });
        writeFileSync(target, serialized);
      }
      expect(existsSync(target), `${target} is missing; run with UPDATE_PROVIDER_GOLDENS=1`).toBe(true);
      expect(JSON.parse(serialized)).toEqual(JSON.parse(readFileSync(target, 'utf8')));
    });
  }
});
