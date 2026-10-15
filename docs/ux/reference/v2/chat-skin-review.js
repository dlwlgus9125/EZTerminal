// Authored design fixtures only. Shared chat interactions are independent of the skin.
window.createChatSkinReview = function ({esc,icon,modal,refresh,canInteract,getScreen,getSession,getSkin,getDraft,setDraft,shell,titleBlock}) {
  const sessions=new Map();
  const sceneNames={ready:'대화 완료',compose:'첨부와 답장',streaming:'응답 중',approval:'승인 대기',review:'결과 나란히 보기'};
  const scene=()=>{const value=new URLSearchParams(location.hash.split('?')[1]||'').get('chatScene');return Object.hasOwn(sceneNames,value)?value:null;};
  const key=()=>`${getScreen().id}:${getSession()}:${scene()||'default'}`;
  const state=()=>{if(!sessions.has(key()))sessions.set(key(),{attachment:scene()==='compose',reply:scene()==='compose'?'대화 화면의 입력과 메시지 표현을 함께 살펴볼 수 있습니다.':'',stopped:false,approval:null,queue:[],toolOpen:false,sent:[]});return sessions.get(key());};
  const preview=()=>`<div class="chat-attachment-drawing" aria-hidden="true"><div></div><span></span><span></span><i></i></div>`;
  const attachment=()=>`<button type="button" class="chat-attachment" data-chat-action="attachment-preview">${preview()}<span><strong>대화 화면.png</strong><small>이미지 · 첨부</small></span></button>`;
  function mount(s) {
    const panel=document.querySelector('.chat-panel');
    if(!panel||!['D18','M04'].includes(s.id))return;
    const scroll=panel.querySelector('.chat-scroll'),form=panel.querySelector('#chat-form');
    if(!scroll||!form)return;
    const st=state(),variant=scene(),mobile=s.platform==='android';
    if(variant==='compose'&&!st.seeded){st.seeded=true;if(!getDraft())setDraft('이 화면의 입력 영역을 조금 더 간결하게 정리해줘.');form.querySelector('textarea').value=getDraft();}
    panel.classList.add('semantic-chat');panel.dataset.chatScene=variant||'ready';
    scroll.setAttribute('aria-label','대화 메시지');
    panel.querySelector('.conversation-day')?.remove();
    const top=panel.querySelector('.chat-top'),role=panel.querySelector('.execution-chat-role');
    if(mobile&&top){
      top.querySelector('[data-target="simulate:skin"]').textContent=getSkin()==='terminal'?'CLI 스킨':'말풍선';
      const instructions=role?.querySelector('button');if(instructions)top.append(instructions);
      role?.remove();
    }
    const policyEntry=scroll.querySelector('.policy-entry');
    if(policyEntry){policyEntry.classList.add('chat-policy-link');panel.querySelector('.child-track')?.append(policyEntry);}
    const assistant=scroll.querySelector('.message.assistant');
    if(variant&&assistant){
      scroll.querySelector('.message.user .bubble').textContent='채팅 기능은 그대로 두고, 코덱스나 클로드 코드 CLI처럼 보이게 해줘.';
      assistant.querySelector('.bubble').textContent='메시지·첨부·대화 기록은 그대로 유지하고, 화면 표현만 CLI 스타일로 바꿀 수 있습니다.';
      assistant.querySelector('.tool-block')?.remove();
      const tool=document.createElement('details');tool.className='chat-tool';tool.open=st.toolOpen;
      tool.innerHTML='<summary>확인한 항목 3개 <span>메시지 · 첨부 · 입력</span></summary><div>대화 내용과 작성 중인 메시지를 유지합니다.<br>첨부·답장·승인 요청을 그대로 이어갑니다.<br>한글 입력과 여러 줄 편집을 사용할 수 있습니다.</div>';
      assistant.querySelector('.bubble').after(tool);
      tool.addEventListener('toggle',()=>{st.toolOpen=tool.open;});
      const bodies=assistant.querySelectorAll('.bubble');const tail=bodies.length>1?bodies[bodies.length-1]:null;
      if(tail)tail.textContent='대화 화면의 입력과 메시지 표현을 함께 살펴볼 수 있습니다.';
      if(variant==='streaming'){
        assistant.querySelector('.artifact-card')?.remove();
        if(tail)tail.textContent=st.stopped?'응답을 중단했습니다. 받은 내용은 대화에 남아 있습니다.':'두 스킨에서 같은 대화 동작을 사용할 수 있도록 입력 영역을 정리하고 있습니다…';
        assistant.insertAdjacentHTML('beforeend',`<div class="chat-stream-status" role="status"><span class="chat-progress-dot" aria-hidden="true"></span>${st.stopped?'중단됨':'응답 작성 중'}${!st.stopped?'<button type="button" data-chat-action="stop">중단</button>':''}</div>`);
      }
      if(variant==='approval'){
        assistant.querySelector('.artifact-card')?.remove();if(tail)tail.remove();
        assistant.insertAdjacentHTML('beforeend',`<section class="chat-approval" aria-label="내보내기 승인 요청"><div class="chat-approval-title">${icon('shield')}<strong>${st.approval?'요청 처리됨':'확인이 필요합니다'}</strong></div><p>기획 문서 2개를 프로젝트 밖 폴더로 내보냅니다.</p><code>C:/Exports/EZTerminal/</code><small>대상 폴더에 새 파일 2개 생성 · 기존 파일 덮어쓰기 없음</small>${st.approval?`<p role="status">${st.approval==='allow'?'이번 요청 허용됨':'요청 거절됨'} · 예시</p>`:'<div class="chat-approval-actions"><button type="button" data-chat-action="deny">거절</button><button type="button" data-chat-action="allow">이번만 허용</button></div>'}</section>`);
      }
    }
    for(const sent of st.sent)scroll.insertAdjacentHTML('beforeend',`<article class="message user"><div class="byline"><span class="person">나</span></div>${sent.reply?`<blockquote class="chat-sent-reply">${esc(sent.reply)}</blockquote>`:''}<div class="bubble">${esc(sent.text)}</div>${sent.attachment?attachment():''}</article><article class="message assistant"><div class="byline"><span class="person">기획 도우미</span></div><div class="bubble">메시지를 확인했습니다. 검토용 응답입니다.</div></article>`);
    [...scroll.querySelectorAll('.message')].forEach((message,index)=>{
      message.dataset.messageId=`${getSession()}-message-${index+1}`;
      const byline=message.querySelector('.byline');
      if(byline&&!byline.querySelector('time'))byline.insertAdjacentHTML('beforeend','<time class="chat-time" datetime="2026-10-13T10:24:00+09:00">10:24</time>');
      const actions=document.createElement('div');actions.className='chat-message-actions';actions.setAttribute('aria-label','메시지 동작');
      actions.innerHTML=`<button type="button" data-chat-action="copy">복사</button><button type="button" data-chat-action="reply">답장</button>${message.classList.contains('user')?'<button type="button" data-chat-action="reuse">입력에 가져오기</button>':''}`;
      message.append(actions);
    });
    const context=document.createElement('div');context.className='chat-compose-context';
    if(st.reply)context.innerHTML=`<div class="chat-reply"><span>답장 <strong>${esc(st.reply)}</strong></span><button type="button" data-chat-action="clear-reply" aria-label="답장 취소">${icon('close')}</button></div>`;
    if(st.attachment)context.insertAdjacentHTML('beforeend',`<div class="chat-pending-attachment">${attachment()}<button type="button" data-chat-action="remove-attachment" aria-label="첨부 제거">${icon('close')}</button></div>`);
    form.prepend(context);form.querySelector('.reference-chip')?.remove();
    const tools=document.createElement('div');tools.className='chat-compose-tools';
    const worker=s.id==='D18'&&getSession()==='worker';
    tools.innerHTML=`<button type="button" data-chat-action="attach">${icon('plus')}<span>첨부</span></button><button type="button" data-chat-action="reference">@<span>참조</span></button><button type="button" data-target="simulate:role-${worker?'windows':'planning'}" class="chat-model">${worker?'UI 담당':'기획 도우미'} · 기본 모델 ${icon('down')}</button>`;
    form.querySelector('label').after(tools);
    const send=form.querySelector('[type="submit"]');
    if(variant==='streaming'&&!st.stopped)send.innerHTML=icon('plus')+' 대기열에 추가';
    if(st.queue.length){const queue=document.createElement('div');queue.className='chat-queue';queue.setAttribute('role','status');queue.textContent=`대기 중 ${st.queue.length} · ${st.queue.at(-1).text||'첨부 이미지'}`;form.prepend(queue);}
    panel.querySelectorAll('[data-chat-action]').forEach(control=>control.addEventListener('click',()=>action(control)));
  }
  function action(control) {
    if(!canInteract())return;
    const st=state(),name=control.dataset.chatAction,message=control.closest('.message');
    const text=message?[...message.querySelectorAll('.bubble')].map(el=>el.textContent).join('\n'):'';
    if(name==='copy'){
      modal('메시지 복사',`<label class="field"><span class="label">복사할 메시지</span><textarea id="message-copy" readonly>${esc(text)}</textarea></label><p>선택한 텍스트를 복사하세요.</p>`);document.querySelector('#message-copy').select();return;
    }
    if(name==='reply'){st.reply=text;refresh();document.querySelector('#chat-draft')?.focus();return;}
    if(name==='reuse'){setDraft(text);refresh();document.querySelector('#chat-draft')?.focus();return;}
    if(name==='clear-reply')st.reply='';
    if(name==='remove-attachment')st.attachment=false;
    if(name==='stop')st.stopped=true;
    if(name==='allow'||name==='deny')st.approval=name;
    if(name==='attach'){modal('첨부하기',`<p>검토용 이미지로 첨부·제거·스킨 전환을 체험합니다.</p>${preview()}<p>대화 화면.png</p>`,'첨부',()=>{st.attachment=true;refresh();});return;}
    if(name==='attachment-preview'){modal('대화 화면.png',`<div class="chat-image-preview">${preview()}</div><p>대화 화면의 이미지 첨부 예시</p>`);return;}
    if(name==='reference'){modal('참조 추가','<p>대화 경험 · 요구사항 · PRD 초안 v0.3</p>','참조 추가',()=>{setDraft(getDraft()+' @대화 경험 ');refresh();document.querySelector('#chat-draft')?.focus();});return;}
    refresh();
  }
  function submit() {
    if(!['D18','M04'].includes(getScreen()?.id)||!document.querySelector('.semantic-chat'))return false;
    const st=state(),text=getDraft().trim();
    if(!text&&!st.attachment)return true;
    if(scene()==='streaming'&&!st.stopped){st.queue.push({text,attachment:st.attachment,reply:st.reply});}
    else if(st.attachment||st.reply||scene()){st.sent.push({text,attachment:st.attachment,reply:st.reply});}
    else return false;
    st.attachment=false;st.reply='';setDraft('');refresh();document.querySelector('#chat-draft')?.focus();return true;
  }
  function portal() {
    const params=new URLSearchParams(location.hash.split('?')[1]||'');
    const current=Object.hasOwn(sceneNames,params.get('scene'))?params.get('scene'):'ready';
    const mobile=params.get('platform')==='android',id=mobile?'M04':'D18';
    const descriptions={ready:'동일한 메시지를 말풍선과 CLI 스킨으로 표시합니다. 복사·답장·산출물 열기는 같습니다.',compose:'이미지 첨부와 답장 맥락, 작성 중 입력을 스킨 전환 후에도 유지합니다.',streaming:'응답 중에도 다음 메시지를 작성합니다. 전송하면 대기열에 들어가며 현재 응답과 섞이지 않습니다.',approval:'승인 대상·이유·허용·거절을 두 스킨에서 동일하게 제공합니다.',review:'대화 옆에 산출물을 열고 메시지를 이어갑니다. 모바일에서는 문서 화면을 열었다 돌아옵니다.'};
    const url=skin=>`#render/${id}?${new URLSearchParams({skin,chatScene:current,interactive:'1',session:'experience',artifact:current==='review'?'1':'0'})}`;
    const figure=(skin,label)=>`<figure class="chat-skin-figure ${mobile?'phone':''}"><div><strong>${label}</strong><a class="btn subtle small" href="${url(skin)}">직접 체험 ${icon('arrow')}</a></div><a href="screens/chat-skins/${id}-${current}-${skin}.png" target="_blank" rel="noopener"><img src="screens/chat-skins/${id}-${current}-${skin}.png" alt="${sceneNames[current]} · ${label} 상세 시안"></a><figcaption>같은 메시지 · 같은 첨부 · 같은 전송 상태</figcaption></figure>`;
    shell(titleBlock('CHAT / CLI SKIN','채팅은 그대로, 모습은 CLI','메시지 기반 채팅에 적용하는 두 표현입니다. 스킨 전환은 세션·AI·실행 모드를 바꾸지 않습니다.',`<a class="btn subtle" href="CHAT-SKINS.md">상세 설계</a>`)+`<div class="chat-skin-platform">${[['windows','Windows'],['android','Android']].map(([key,label])=>`<a class="btn ${mobile===(key==='android')?'primary':'subtle'}" href="#chat-skins?platform=${key}&scene=${current}">${label}</a>`).join('')}</div><nav class="chat-scene-tabs" aria-label="대화 상태">${Object.entries(sceneNames).map(([key,label])=>`<a href="#chat-skins?platform=${mobile?'android':'windows'}&scene=${key}" ${key===current?'aria-current="page"':''}>${label}</a>`).join('')}</nav><p class="chat-scene-description">${descriptions[current]}</p><div class="chat-skin-figures">${figure('bubble','말풍선 스킨')}${figure('terminal','CLI 스킨')}</div><div class="chat-skin-principle"><strong>확인할 핵심</strong><p>CLI 스킨에서도 메시지·선택·첨부·답장·승인이 각각의 채팅 요소로 남습니다. 실제 셸은 별도 터미널에서 엽니다.</p></div>`,'design','채팅 · CLI 스킨 상세');
  }
  function capture() {
    const input=document.querySelector('#chat-draft'),scroll=document.querySelector('.chat-scroll');
    const item=scroll&&[...scroll.querySelectorAll('[data-message-id]')].find(el=>el.getBoundingClientRect().bottom>scroll.getBoundingClientRect().top);
    return {focus:document.activeElement===input,start:input?.selectionStart,end:input?.selectionEnd,anchor:item?.dataset.messageId,offset:item&&item.getBoundingClientRect().top-scroll.getBoundingClientRect().top};
  }
  function restore(view) {
    requestAnimationFrame(()=>{
      const scroll=document.querySelector('.chat-scroll');
      const item=scroll&&[...scroll.querySelectorAll('[data-message-id]')].find(el=>el.dataset.messageId===view.anchor);
      if(item)scroll.scrollTop+=item.getBoundingClientRect().top-scroll.getBoundingClientRect().top-view.offset;
      const input=document.querySelector('#chat-draft');
      if(input&&view.start!==undefined){input.setSelectionRange(view.start,view.end);if(view.focus)input.focus({preventScroll:true});}
    });
  }
  return {mount,submit,portal,capture,restore};
};
