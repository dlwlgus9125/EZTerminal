import { describe, expect, it } from 'vitest';

import {
  buildProviderProcessEnvironment,
  sanitizeProviderDiagnostic,
} from './provider-process-security';

describe('provider process security', () => {
  it('copies required OS values and only explicitly disclosed provider variables', () => {
    const environment = buildProviderProcessEnvironment(
      ['ANTHROPIC_API_KEY', 'HTTPS_PROXY'],
      {
        PATH: '/tools',
        HOME: '/home/tester',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        HTTPS_PROXY: 'http://proxy.test',
        GITHUB_TOKEN: 'must-not-cross',
        CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross-either',
      },
      { CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2' },
    );

    expect(environment).toEqual({
      PATH: '/tools',
      HOME: '/home/tester',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      HTTPS_PROXY: 'http://proxy.test',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
    });
  });

  it('redacts provider keys, headers, JWTs, env assignments, and explicit orchestration tokens', () => {
    const result = sanitizeProviderDiagnostic([
      'sk-ant-api03-secretmaterial',
      'sk-proj-openaisupersecretvalue',
      'Authorization: Bearer bearer-secret-value',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue',
      'AWS_SECRET_ACCESS_KEY=cloud-secret',
      'orchestration-only-token',
    ].join(' '), { explicitSecrets: ['orchestration-only-token'] });

    expect(result.redacted).toBe(true);
    expect(result.text).not.toMatch(/secretmaterial|openaisupersecretvalue|bearer-secret|signaturevalue|cloud-secret|orchestration-only/u);
    expect(result.text).toContain('[redacted');
  });
});
