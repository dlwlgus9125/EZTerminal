// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { applyHtmlLanguage, createAppI18n } from './index';
import { appResources } from './resources';

function leafKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === 'object' && child !== null ? leafKeys(child as object, path) : [path];
  });
}

describe('application i18n', () => {
  it('creates typed Korean and English instances from the same resources', () => {
    const korean = createAppI18n('system', ['ko-KR']);
    const english = createAppI18n('system', ['en-US', 'ko-KR']);
    expect(korean.t('header.newTerminal')).toBe('새 터미널');
    expect(korean.t('settings.lineThickness', { value: 4 })).toBe('선 두께: 4px');
    expect(korean.t('workbench.resizeSidebar')).toBe('사이드바 크기 조절');
    expect(korean.t('remote.pairingTitle')).toBe('모바일 페어링');
    expect(korean.t('monitor.showPackets')).toBe('패킷 보기');
    expect(korean.t('openClaw.state.running')).toBe('실행 중');
    expect(korean.t('safetyDialog.closeActiveTitle')).toBe('활성 터미널을 닫으시겠습니까?');
    expect(korean.t('safetyDialog.risks.sshActive')).toBe('활성 SSH 연결');
    expect(korean.t('settings.themeImportUnavailable')).toBe('데스크톱 테마 가져오기를 사용할 수 없습니다.');
    expect(korean.t('recentPanels.statuses.sshPrompt')).toBe('SSH 프롬프트');
    expect(korean.t('recentPanels.agentStatus', { status: '대기 중' })).toBe('에이전트 대기 중');
    expect(korean.t('terminalContext.shortcut', { shortcut: 'F2' })).toBe('단축키 F2');
    expect(korean.t('header.effectsTrigger', { profile: 'CRT' })).toBe('효과: CRT');
    expect(korean.t('header.profileCustom')).toBe('사용자 설정');
    expect(korean.t('header.motionPaused')).toBe('시스템 설정에 따라 움직이는 효과가 일시 정지됨');
    expect(english.t('header.newTerminal')).toBe('New Terminal');
    expect(english.t('header.effectsTrigger', { profile: 'CRT' })).toBe('Effects: CRT');
    expect(english.t('monitor.showPackets')).toBe('Show packets');
    expect(english.t('openClaw.state.running')).toBe('Running');
    expect(english.t('safetyDialog.applyPresetTitle', { name: 'focus' })).toBe('Apply preset “focus”?');
  });

  it('falls back to English for unknown keys and never returns null', () => {
    const instance = createAppI18n('en', []);
    expect(instance.t('state.errorTitle')).toBe('Something went wrong');
  });

  it('updates the document language for assistive technology', () => {
    applyHtmlLanguage('ko');
    expect(document.documentElement.lang).toBe('ko');
    applyHtmlLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps Korean and English resource coverage in lockstep', () => {
    expect(leafKeys(appResources.ko.translation).sort()).toEqual(
      leafKeys(appResources.en.translation).sort(),
    );
  });
});
