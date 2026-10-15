/* In-memory design interaction. No model calls or product settings are written. */
window.createProfileReview = function(h) {
  const {data,esc,button,modal,canInteract}=h;
  const saved={}, drafts={}, history={};
  const base=id=>['windows','android'].includes(id)?'builder':id;
  const spec=id=>data.aiProfiles.find(p=>p.id===base(id));
  const initial=id=>({provider:'inherit',model:'default',effort:'supported',prompt:spec(id).prompt,context:spec(id).inputs.join('\n'),tools:spec(id).tools,version:1});
  const profile=id=>saved[id]||(['windows','android'].includes(id)?profile('builder'):(saved[id]=initial(id)));
  const draft=id=>drafts[id]||(drafts[id]={...profile(id)});
  const select=(label,key,options,p)=>`<label class="field"><span class="label">${label}</span><select id="role-${key}" data-profile-field="${key}">${options.map(([v,n])=>`<option value="${v}" ${p[key]===v?'selected':''}>${n}</option>`).join('')}</select></label>`;
  function fields(id) {
    const p=draft(id), current=profile(id);
    return `<div class="profile-editor" data-profile-editor="${id}"><div class="row between"><strong>저장 버전 v${current.version}</strong><span class="tiny muted">검토용 설정 · 실제 연결 없음</span></div>
      <div class="row wrap"><button class="btn primary" data-profile-save>변경 저장</button><button class="btn subtle" data-profile-ai>AI 수정 제안 보기</button><button class="btn quiet" data-profile-discard>편집 취소</button><button class="btn quiet" data-profile-history>버전 이력</button></div>
      <div class="execution-fields">${select('연결 AI','provider',[['inherit','프로젝트 기본 · 예시'],['alternate','다른 연결 AI · 예시'],['missing','연결되지 않은 AI · 오류 예시']],p)}${select('모델','model',[['default','기본 모델 · 지원 예시'],['alternate','다른 모델 · 지원 예시'],['unsupported','지원되지 않는 모델 · 오류 예시']],p)}${select('추론 설정','effort',[['supported','제공자가 지원하는 값 · 예시'],['default','제공자 기본값']],p)}</div>
      <label class="field"><span class="label">역할 지시문</span><textarea id="role-prompt" data-profile-field="prompt" rows="5">${esc(p.prompt)}</textarea></label>
      <div class="grid2"><label class="field"><span class="label">참조 문맥 · 항목별 한 줄</span><textarea id="role-context" data-profile-field="context" rows="3">${esc(p.context)}</textarea></label><label class="field"><span class="label">허용 도구</span><textarea id="role-tools" data-profile-field="tools" rows="3">${esc(p.tools)}</textarea></label></div>
      <p class="tiny muted">상위 제한: ${esc(spec(id).permission)}. 허용 도구 편집으로 상위 권한을 넓힐 수 없습니다.</p>

      <p class="profile-status tiny" role="status">미저장 변경은 실행에 적용되지 않습니다.</p>
      <details class="execution-prompt"><summary>저장된 지시 원문 · v${current.version}</summary><pre>${esc(current.prompt)}</pre></details>
      <div class="callout">현재 실행은 고정된 v1 예시를 유지합니다. 저장한 설정은 새 실행부터 적용됩니다.</div></div>`;
  }
  function persist(id,values) {
    const old=profile(id);(history[id]||(history[id]=[])).push({...old});
    saved[id]={...values,version:old.version+1};drafts[id]={...saved[id]};h.onSave?.();
  }
  function redraw(root,id,status) {
    const editor=root.querySelector(`[data-profile-editor="${id}"]`);
    if(!editor)return;
    editor.outerHTML=fields(id);bindFields(root,id);
    const next=root.querySelector(`[data-profile-editor="${id}"]`);
    if(status)next.querySelector('.profile-status').textContent=status;
    next.querySelector('[data-profile-save]')?.focus();
  }
  function bindFields(root,id) {
    const editor=root.querySelector(`[data-profile-editor="${id}"]`);if(!editor)return;
    editor.querySelectorAll('[data-profile-field]').forEach(el=>el.addEventListener('input',()=>{if(canInteract()){draft(id)[el.dataset.profileField]=el.value;editor.querySelector('.profile-status').textContent='미저장 변경이 있습니다.';}}));
    editor.querySelector('[data-profile-save]').addEventListener('click',()=>{if(!canInteract())return;persist(id,draft(id));redraw(root,id,'새 버전을 저장했습니다. 진행 중 시도는 기존 설정을 유지합니다.');});
    editor.querySelector('[data-profile-discard]').addEventListener('click',()=>{if(!canInteract())return;drafts[id]={...profile(id)};redraw(root,id,'미저장 편집을 취소했습니다.');});
    editor.querySelector('[data-profile-ai]').addEventListener('click',()=>{
      if(!canInteract())return;
      const baseVersion=profile(id).version, before={...draft(id)};
      const proposed={...before,prompt:before.prompt+'\n수용 조건별로 근거와 미실행 항목을 구분하고, 결과 revision이 바뀌면 재검토하세요.'};
      const proposal=document.createElement('section');proposal.className='profile-proposal panel';
      proposal.innerHTML=`<h3>AI 수정 제안 · 적용 전</h3><p>이유: 검토 근거와 미실행 항목을 빠짐없이 확인하도록 지시를 구체화합니다.</p><div class="grid2"><div><strong>변경 전</strong><pre>${esc(before.prompt)}</pre></div><div><strong>변경 후</strong><pre>${esc(proposed.prompt)}</pre></div></div><p>모델·문맥·도구·상위 제한은 그대로입니다. 실제 AI 호출 없이 보여 주는 예시입니다.</p><button class="btn primary" data-profile-apply>제안 적용</button> <button class="btn subtle" data-profile-reject>제안 취소</button>`;
      editor.querySelector('.profile-proposal')?.remove();editor.append(proposal);
      proposal.querySelector('[data-profile-apply]').addEventListener('click',()=>{if(!canInteract())return;if(profile(id).version!==baseVersion||JSON.stringify(draft(id))!==JSON.stringify(before)){proposal.innerHTML='<p role="alert">저장 버전이 바뀌었습니다. 새 기준으로 다시 비교하세요.</p>';return;}persist(id,proposed);redraw(root,id,'AI 제안을 적용해 새 버전을 저장했습니다. 진행 중 시도는 v1을 유지합니다.');});
      proposal.querySelector('[data-profile-reject]').addEventListener('click',()=>{proposal.remove();editor.querySelector('[data-profile-ai]').focus();});
      proposal.querySelector('button').focus();
    });
    editor.querySelector('[data-profile-history]').addEventListener('click',()=>{
      if(!canInteract())return;editor.querySelector('.profile-history')?.remove();
      const section=document.createElement('section');section.className='profile-history panel';
      const entries=history[id]||[];section.innerHTML=`<h3>버전 이력 · 현재 v${profile(id).version}</h3>${entries.length?entries.map((p,i)=>`<p>v${p.version} <button class="btn subtle small" data-restore-version="${i}">이 내용으로 되돌리기</button></p>`).join(''):'<p>아직 이전 버전이 없습니다.</p>'}<p>되돌리기도 새 버전으로 기록합니다.</p>`;
      section.querySelectorAll('[data-restore-version]').forEach(b=>b.addEventListener('click',()=>{persist(id,entries[Number(b.dataset.restoreVersion)]);redraw(root,id,'선택한 내용을 새 버전으로 복원했습니다.');}));editor.append(section);
    });
  }
  return {profile,fields,bindFields};
};
