// CLI is a presentation skin over the same chat DOM. No shell emulation.
window.mountTerminalSkin = function ({mobile}) {
  for (const panel of document.querySelectorAll('.chat-panel')) {
    const form=panel.querySelector('#chat-form');
    if (!form) continue;
    panel.classList.add('console-session');
    for (const message of panel.querySelectorAll('.message')) {
      const byline=message.querySelector('.byline');
      if (!byline) continue;
      const marker=document.createElement('span');
      marker.className='console-output-mark';
      marker.setAttribute('aria-hidden','true');
      marker.textContent=message.classList.contains('user')?'›':'●';
      byline.prepend(marker);
    }
    const label=form.querySelector('label');
    const prompt=document.createElement('div');
    prompt.className='console-prompt';
    prompt.innerHTML='<span class="console-prompt-mark" aria-hidden="true">›</span>';
    label.before(prompt);prompt.append(label);
    const input=form.querySelector('textarea');
    input.rows=1;input.placeholder='메시지 입력…';
    const fit=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,112)+'px';};
    input.addEventListener('input',fit);requestAnimationFrame(fit);
    const hint=form.querySelector('.composer-meta>span');
    if(hint)hint.textContent=mobile?'Enter 줄바꿈 · 버튼으로 전송':'Enter 전송 · Shift+Enter 줄바꿈';
    panel.querySelectorAll('[data-target="simulate:skin"]').forEach(button=>{button.textContent='CLI 스킨';});
  }
};
