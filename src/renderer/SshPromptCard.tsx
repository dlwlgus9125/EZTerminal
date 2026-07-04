import { useState } from 'react';

import type { BlockController, SshPromptState } from './block-controller';

// SshPromptCard — the pre-schema `ssh-connect` prompt (E5): a masked input for
// password/passphrase, or a fingerprint + accept/reject decision for an unknown
// host key (TOFU). Rendered by Block.tsx BEFORE its shape switch, since a block
// with an outstanding prompt has no shape yet. Nothing typed here is logged —
// the value only ever leaves via `sendSshPromptResponse` straight to the
// per-block port.

export function SshPromptCard({
  controller,
  prompt,
}: {
  controller: BlockController;
  prompt: SshPromptState;
}): JSX.Element {
  const [value, setValue] = useState('');

  if (prompt.kind === 'hostkey') {
    return (
      <div className="ssh-prompt" data-testid="ssh-prompt">
        <p className="ssh-prompt-message">{prompt.message}</p>
        {prompt.fingerprint && (
          <p className="ssh-prompt-fingerprint" data-testid="ssh-prompt-fingerprint">
            {prompt.fingerprint}
          </p>
        )}
        <div className="ssh-prompt-actions">
          <button
            type="button"
            className="btn"
            data-testid="ssh-prompt-accept"
            onClick={() => controller.sendSshPromptResponse(prompt.promptId, { accept: true })}
          >
            Accept
          </button>
          <button
            type="button"
            className="btn btn-cancel"
            data-testid="ssh-prompt-reject"
            onClick={() => controller.sendSshPromptResponse(prompt.promptId, { accept: false })}
          >
            Reject
          </button>
        </div>
      </div>
    );
  }

  const submit = (): void => controller.sendSshPromptResponse(prompt.promptId, { value });

  return (
    <div className="ssh-prompt" data-testid="ssh-prompt">
      <label className="ssh-prompt-message" htmlFor={`ssh-prompt-input-${prompt.promptId}`}>
        {prompt.message}
      </label>
      <input
        id={`ssh-prompt-input-${prompt.promptId}`}
        type="password"
        className="ssh-prompt-input"
        data-testid="ssh-prompt-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button type="button" className="btn" data-testid="ssh-prompt-submit" onClick={submit}>
        Submit
      </button>
    </div>
  );
}
