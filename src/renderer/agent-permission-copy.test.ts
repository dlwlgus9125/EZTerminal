import { describe, expect, it } from 'vitest';

import { ACCESS_LEVELS, agentPermissionCopy, permissionPresetHint, permissionPresetLabel } from './agent-permission-copy';

describe('agent permission copy', () => {
  it('offers only access levels; plan is not one of them', () => {
    expect(ACCESS_LEVELS).toEqual(['standard', 'full-access']);
  });

  it('names every level in Korean and English', () => {
    for (const locale of ['ko', 'en'] as const) {
      const copy = agentPermissionCopy(locale);
      for (const level of ACCESS_LEVELS) {
        expect(copy.levels[level].label.trim()).not.toBe('');
        expect(copy.levels[level].hint.trim()).not.toBe('');
      }
    }
    expect(permissionPresetLabel('standard', 'ko')).toBe('승인 후 실행');
    expect(permissionPresetLabel('full-access', 'ko')).toBe('전체 권한');
    expect(permissionPresetLabel('standard', 'en')).toBe('Ask before running');
  });

  it('keeps Korean copy free of the old English preset names', () => {
    const ko = JSON.stringify(agentPermissionCopy('ko'));
    expect(ko).not.toMatch(/\b(?:Plan|Standard|Full access)\b/u);
  });

  it('shows plan as the plan switch in a conversation and as plan-only for automated agents', () => {
    expect(permissionPresetLabel('plan', 'ko')).toBe('계획');
    expect(permissionPresetLabel('plan', 'ko', 'automated')).toBe('계획만 · 읽기 전용');
    expect(permissionPresetLabel('plan', 'en', 'automated')).toBe('Plan only · read-only');
    expect(permissionPresetHint('plan', 'en', 'automated')).not.toMatch(/approv/iu);
  });
});
