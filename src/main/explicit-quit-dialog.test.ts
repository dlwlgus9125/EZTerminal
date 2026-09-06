import { describe, expect, it } from 'vitest';

import { buildExplicitQuitDialogOptions } from './explicit-quit-dialog';

describe('buildExplicitQuitDialogOptions', () => {
  it('keeps the ordinary quit warning when no Agent create is pending', () => {
    expect(buildExplicitQuitDialogOptions('en', false)).toMatchObject({
      message: 'Quit EZTerminal?',
      detail: 'All running terminal and agent sessions will stop. To close only the window, cancel and use the window close button.',
      buttons: ['Cancel', 'Quit'],
      defaultId: 0,
      cancelId: 0,
    });
  });

  it.each([
    ['en', 'Unconfirmed Agent creation recovery information will be discarded', 'already delivered', 'duplicate'],
    ['ko', '확인이 끝나지 않은 Agent 생성 복구 정보는 종료할 때 폐기됩니다', '이미 전달됐다면', '중복될 수 있습니다'],
  ] as const)(
    'warns in %s that a pending envelope is discarded and could duplicate',
    (locale, discarded, delivered, duplicate) => {
      const options = buildExplicitQuitDialogOptions(locale, true);

      expect(options.detail).toContain(discarded);
      expect(options.detail).toContain(delivered);
      expect(options.detail).toContain(duplicate);
      expect(options.defaultId).toBe(0);
      expect(options.cancelId).toBe(0);
    },
  );
});
