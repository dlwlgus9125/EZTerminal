/* Review-only project/plan navigation. All records live in this page's memory. */
(() => {
  const createStageJourney = window.createJourney;
  const scenes = [
    ['plans-home', '프로젝트 · 시작과 이어가기', 'Project · Start and continue'],
    ['plans-empty', '기획이 없는 프로젝트', 'Project without plans'],
    ['plans-list', '여러 기획과 전환', 'Plans and switching'],
    ['plans-new', '새 기획 만들기', 'Create a plan'],
    ['plans-from-chat', '대화를 기획으로 연결', 'Connect a conversation to a plan'],
    ['plans-linked', '새 기획과 연결된 대화', 'Conversation linked to a new plan'],
    ['plans-quick', '기획 없이 빠른 작업', 'Quick task without a plan'],
    ['plans-rework', '검토 후 수정으로 돌아가기', 'Return from review to revision'],
    ['plans-archived', '보관한 기획 다시 열기', 'Reopen an archived plan']
  ];
  window.CHAT_REVIEW.scenes.unshift(...scenes.map(([id, ko, en]) => ({id, name:[ko,en], group:['기획 시작과 연결','Plan lifecycle'], description:['시작·대화·전환·복귀를 직접 체험합니다.','Try starting, discussing, switching and returning.']})));

  window.createJourney = api => {
    const {state, session, t, esc, icon, button, badge, modal, cancel, openOverlay, render, captureView, updateUrl, freshSession, toast} = api;
    let entries = [], fallback, selected = null, view = 'home', counter = 0, form = {}, search = '', filter = 'active', collectionArea = 'planning', prior = null;
    const stageLabel = area => ({overview:t('개요','Overview'),planning:t('기획','Planning'),design:t('디자인','Design'),chat:t('대화','Chat'),tasks:t('작업','Tasks'),review:t('검토','Review'),files:t('파일','Files')})[area];
    const current = () => entries.find(entry => entry.id === (state.route === 'chat' && session()?.workflow?.planId ? session().workflow.planId : selected));
    const engine = () => current()?.engine || fallback;
    const activeEntries = () => entries.filter(entry => !entry.quick);
    const capture = () => {engine()?.capture(); captureView();};
    const field = (label, name, value, textarea=false) => `<label class="plan-field" for="${name}"><span>${label}</span>${textarea?`<textarea id="${name}" rows="5" maxlength="4000">${esc(value||'')}</textarea>`:`<input id="${name}" maxlength="160" value="${esc(value||'')}">`}</label>`;
    function route(next, scene) {capture(); view=next; state.route='stage'; state.overlay=null; state.scene=scene; updateUrl(); render(); document.getElementById('content')?.focus({preventScroll:true});}
    function addEntry(id, title, purpose, extra={}) {
      const entry={id,title,purpose,status:'active',history:[],...extra};
      entry.engine=createStageJourney({...api, planConfig:{id,title:entry.example?undefined:title,purpose,example:entry.example,quick:entry.quick},navigationTabs:tabs});
      entry.engine.reset('welcome'); entries.push(entry); return entry;
    }
    function openEntry(id, area=collectionArea) {
      capture(); const entry=entries.find(item=>item.id===id); if(!entry)return;
      if(entry.quick)area='tasks';selected=id;view='detail';entry.engine.jump(area);state.scene=area==='planning'?'flow-planning':`flow-${area}`;updateUrl();
    }
    function reset(scene) {
      entries=[]; selected=null;view='home';counter=0;search='';filter='active';form={};prior=null;collectionArea='planning';
      fallback=createStageJourney({...api,navigationTabs:tabs});fallback.reset('welcome');
      if(scene!=='plans-empty') {
        addEntry('login',t('로그인 접근성 개선','Login accessibility'),'',{example:true});
        addEntry('payment',t('결제 수단 추가','Add payment methods'),t('사용자가 결제 수단을 등록하고 기본 수단을 선택할 수 있게 한다.','Let users add payment methods and choose a default.'));
      }
      if(scene.startsWith('flow-')) {selected='login';view='detail';current().engine.reset(scene);return;}
      if(!scene.startsWith('plans-')) {view='detail';return;}
      state.route='stage';
      if(scene==='plans-empty'||scene==='plans-list')view='list';
      if(scene==='plans-new'){view='new';form={title:'',purpose:'',target:'new'};}
      if(scene==='plans-from-chat'){
        state.route='chat';view='detail';session().title=t('결제 경험 논의','Discuss the payment experience');
        session().messages=[{role:'user',text:t('결제 수단을 추가하고 기본 수단을 선택하는 기능을 만들고 싶어.','I want users to add payment methods and select a default.')},{role:'assistant',text:t('등록, 기본 수단 선택, 삭제 시 예외를 나누어 정리할 수 있습니다. 기획에 연결하면 이 논의를 계속 이어갈 수 있습니다.','We can separate registration, default selection and removal edge cases. Connect this discussion to a plan to continue it.')}];
      }
      if(scene==='plans-linked'){selected='payment';view='detail';current().engine.openChat('planning');}
      if(scene==='plans-quick'){view='quick';form={title:'',purpose:'',path:'src/',acceptance:''};}
      if(scene==='plans-rework'){selected='login';view='detail';current().engine.reset('flow-review-chat');current().engine.jump('review');}
      if(scene==='plans-archived'){entries.find(e=>e.id==='payment').status='archived';filter='archived';view='list';}
      state.scene=scene;
    }
    function scope() {
      const item=current(), general=state.route==='chat'&&!session()?.workflow;
      return `<div class="plan-scope"><div class="plan-scope-name">${icon(item?.quick?'Wrench':'Folder')}${item&&!general?button('p-rename',item.title,'Pencil','plan-name-button',`aria-label="${t('기획 이름 변경','Rename plan')} · ${esc(item.title)}"`):`<strong>${general?t('일반 대화','General conversation'):t('전체 기획','All plans')}</strong>`}${item&&!general?badge(item.quick?t('빠른 작업','Quick task'):item.status==='archived'?t('보관됨','Archived'):t('진행 중','Active')):''}</div><div class="actions">${button('p-list',t('기획 목록','Plans'),'List','btn ghost')}${button('p-new',t('새 기획','New plan'),'Plus','btn')}</div></div>`;
    }
    function tabs(active) {
      return `<nav class="project-tabs flow-tabs" aria-label="${t('프로젝트 영역','Project areas')}">${['overview','planning','design','chat','tasks','review','files'].map(area=>button(area==='chat'?'j-last-chat':'j-area',stageLabel(area),null,active===area?'active':'',`data-id="${area}" ${active===area?'aria-current="page"':''}`)).join('')}</nav>${scope()}`;
    }
    function heading(title, description, action='') {return `<div class="flow-heading"><div><div class="eyebrow">EZTerminal / ${t('프로젝트','Project')}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;}
    function rows(list) {
      return `<div class="plan-list">${list.map(entry=>`<article class="plan-row"><button class="plan-open" data-action="p-open" data-id="${entry.id}">${icon('FileText')}<span><strong>${esc(entry.title)}</strong><small>${entry.quick?t('기획 없는 빠른 작업','Quick task without a plan'):entry.status==='archived'?t('보관됨 · 기록 유지','Archived · History preserved'):entry.status==='complete'?t('완료','Completed'):t('진행 중','Active')} · ${t('문서·대화 이어가기','Continue documents and conversations')}</small>${entry.purpose?`<span class="plan-excerpt">${esc(entry.purpose)}</span>`:''}</span>${icon('ChevronRight')}</button><div class="plan-row-actions">${button(entry.status==='archived'?'p-restore':'p-archive',entry.status==='archived'?t('복원','Restore'):t('보관','Archive'),entry.status==='archived'?'History':'Archive','btn ghost',`data-id="${entry.id}"`)}</div></article>`).join('')}</div>`;
    }
    function page() {
      if(view==='detail') {
        const entry=current();
        let result=engine().page();
        if(entry?.status==='archived')result=result.replace('<div class="flow-page-inner">',`<div class="flow-page-inner"><div class="notice warning"><p>${t('보관한 기획입니다. 편집하거나 실행하려면 먼저 복원하세요.','This plan is archived. Restore it before editing or execution.')}</p>${button('p-restore',t('기획 복원','Restore plan'),'History','btn',`data-id="${entry.id}"`)}</div>`);
        if(entry&&engine().inspect().area==='review'&&engine().inspect().taskStatus==='completed')result=result.replace('<div class="flow-page-inner">',`<div class="flow-page-inner"><div class="plan-rework">${icon('MessageSquare')}<span>${t('수정이 필요하면 이 결과를 남기고 기획으로 돌아갑니다.','Keep this result and return to the plan when revisions are needed.')}</span>${button('p-rework',t('수정 요청 정리','Request revisions'),'Pencil')}</div>`);
        if(entry?.history.length)result=result.replace('<div class="flow-page-inner">',`<div class="flow-page-inner"><div class="plan-rework"><span>${t('이전 결과와 수정 요청이 보관되어 있습니다.','Previous results and revision requests are preserved.')}</span>${button('p-history',t('이전 결과','Previous result'),'History')}</div>`);
        return result;
      }
      let body='', area='overview';
      if(view==='home')body=heading(t('무엇부터 시작할까요?','Where would you like to start?'),t('아이디어를 기획으로 정리하거나, AI와 대화하고 작은 작업부터 시작하세요.','Shape an idea into a plan, talk with AI, or start with a small task.'))+`<div class="plan-starts"><button data-action="p-new">${icon('FileText')}<strong>${t('새 기획','New plan')}</strong><span>${t('목적부터 정리하고 단계별로 이어가기','Start with a goal and follow it through')}</span>${icon('ArrowRight')}</button><button data-action="new-chat">${icon('MessageSquare')}<strong>${t('일반 대화','General conversation')}</strong><span>${t('스킬과 모델을 확인하고 바로 대화','Choose skills and a model before sending')}</span>${icon('ArrowRight')}</button><button data-action="p-quick">${icon('Wrench')}<strong>${t('빠른 작업','Quick task')}</strong><span>${t('작업 범위와 완료 조건으로 바로 시작','Start with a scope and acceptance criteria')}</span>${icon('ArrowRight')}</button></div><div class="plan-section-heading"><h2>${t('최근 기획','Recent plans')}</h2>${button('p-list',t('전체 보기','View all'),'ChevronRight','btn ghost')}</div>${rows(activeEntries().filter(e=>e.status!=='archived'))}<p class="flow-bottom-note">${t('일반 대화와 빠른 작업은 기획을 만들지 않아도 사용할 수 있습니다.','General conversations and quick tasks are available without a plan.')}</p>`;
      if(view==='list') {
        area=collectionArea;
        const all=collectionArea==='tasks'?entries:activeEntries(), shown=all.filter(entry=>(filter==='all'||(filter==='archived'?entry.status==='archived':entry.status!=='archived'))&&`${entry.title} ${entry.purpose}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
        body=heading(collectionArea==='planning'?t('기획','Plans'):stageLabel(collectionArea),t('기획을 선택하면 관련 문서와 대화, 작업을 이어갑니다.','Choose a plan to continue its documents, conversations and tasks.'),button('p-new',t('새 기획','New plan'),'Plus','btn primary'))+`<div class="plan-filters"><label for="p-search">${t('기획 검색','Search plans')}<input id="p-search" type="search" value="${esc(search)}" placeholder="${t('이름이나 목적 검색','Search name or purpose')}"></label><label for="p-filter">${t('표시','Show')}<select id="p-filter">${[['active',t('진행·완료','Active and completed')],['archived',t('보관됨','Archived')],['all',t('전체','All')]].map(([key,label])=>`<option value="${key}" ${filter===key?'selected':''}>${label}</option>`).join('')}</select></label></div>${shown.length?rows(shown):`<div class="plan-empty">${icon('FileText')}<h2>${all.length?t('조건에 맞는 기획이 없습니다','No matching plans'):t('첫 기획을 시작해 보세요','Start your first plan')}</h2><p>${all.length?t('검색어나 표시 범위를 바꿔 보세요.','Change your search or filter.'):t('아직 정리되지 않은 아이디어도 괜찮습니다. 목적부터 적고 AI와 구체화하세요.','Start with a rough idea and a goal, then work out the details with AI.')}</p>${all.length?button('p-clear',t('검색·필터 초기화','Clear search and filters'),'RefreshCw'):button('p-new',t('새 기획 만들기','Create a plan'),'Plus','btn primary')}</div>`}`;
      }
      if(view==='new') {
        area='planning';body=heading(form.linkSession?t('대화를 기획으로 연결','Connect this conversation'):t('새 기획 만들기','Create a plan'),t('목적을 간단히 적어 주세요. 나머지는 작성하면서 구체화할 수 있습니다.','Start with a short goal. You can work out the details as you go.'))+`<section class="plan-form">${form.linkSession?`<label class="plan-field" for="p-target"><span>${t('연결할 기획','Destination plan')}</span><select id="p-target"><option value="new">${t('새 기획 만들기','Create a new plan')}</option>${activeEntries().filter(e=>e.status!=='archived').map(e=>`<option value="${e.id}" ${form.target===e.id?'selected':''}>${esc(e.title)}</option>`).join('')}</select></label>`:''}${form.target!=='new'&&form.target?`<p class="plan-form-note">${t('기존 기획의 문서는 그대로 두고 이 대화를 연결합니다.','Link this conversation while preserving the existing plan document.')}</p>`:field(t('기획 이름 · 나중에 변경 가능','Plan name · Can be changed later'),'p-title',form.title)}${field(form.linkSession?t('연결할 논의 · 확인하고 수정하세요','Discussion to link · Review and edit'):t('무엇을 만들거나 개선하고 싶나요?','What would you like to build or improve?'),'p-purpose',form.purpose,true)}<p class="plan-form-note">${form.linkSession?t('원래 대화는 그대로 이어집니다. 선택한 요약만 기획의 출발 자료로 사용합니다.','Continue the original conversation. Only this reviewed summary becomes source material.'):t('기획을 만든 뒤 직접 작성하거나 AI와 정리할 수 있습니다.','After creating the plan, write directly or work with AI.')}</p><div class="actions">${button('p-cancel',t('취소','Cancel'),'ArrowLeft')}${button('p-create',form.target&&form.target!=='new'?t('이 기획에 연결','Link to this plan'):t('기획 만들기','Create plan'),'Check','btn primary')}</div></section>`;
      }
      if(view==='quick') {area='tasks';body=heading(t('빠른 작업','Quick task'),t('작은 변경은 목적과 범위를 확인하고 바로 진행하세요.','For a small change, confirm the goal and scope and get started.'))+`<section class="plan-form">${field(t('작업 이름','Task name'),'p-title',form.title)}${field(t('하려는 작업','Task goal'),'p-purpose',form.purpose,true)}${field(t('대상 경로','Target path'),'p-path',form.path)}${field(t('완료 조건','Acceptance criteria'),'p-acceptance',form.acceptance,true)}<p class="plan-form-note">${t('기획 문서는 만들지 않습니다. 다음 화면에서 실행 기준을 확인하고 시작합니다.','No plan document is created. Review the execution criteria on the next screen before starting.')}</p><div class="actions">${button('p-cancel',t('돌아가기','Back'),'ArrowLeft')}${button('p-quick-create',t('작업 내용 확인','Review task'),'ArrowRight','btn primary')}</div><p id="p-form-error" class="warn" role="status"></p></section>`;}
      return `${tabs(area)}<div class="flow-page"><div class="flow-page-inner">${body}</div></div>`;
    }
    function sidebar() {
      const item=current();
      return `<aside class="sidebar" aria-label="${t('프로젝트 탐색','Project navigation')}"><div class="row project-name">${icon('FolderOpen')} EZTerminal</div><div class="sidebar-heading"><h2>${item?esc(item.title):t('내 프로젝트','My project')}</h2></div><div class="session-list">${item&&view==='detail'?`${button('p-list',t('기획 목록으로','Back to plans'),'ArrowLeft','session-row')}${['planning','design','tasks','review'].map(area=>button('j-area',stageLabel(area),area==='design'?'Layers':area==='tasks'?'Wrench':'FileText','session-row',`data-id="${area}"`)).join('')}`:`${button('p-home',t('개요','Overview'),'Folder','session-row')}${button('p-list',t('기획 목록','Plans'),'FileText','session-row')}${button('p-new',t('새 기획','New plan'),'Plus','session-row')}${button('p-quick',t('빠른 작업','Quick task'),'Wrench','session-row')}`}</div><div class="sidebar-footer"><strong>WORKSTATION</strong><small>C:/Projects/EZTerminal</small><small>${t('문서와 대화를 같은 프로젝트에서','Documents and conversations in one project')}</small></div></aside>`;
    }
    function context() {
      if(session()?.workflow)return engine().context();
      return `<section class="plan-chat-link"><span>${t('논의가 구체화되면 기획으로 이어갈 수 있습니다.','Turn this discussion into a plan when you are ready.')}</span>${button('p-link',t('기획으로 정리','Organize into a plan'),'FileText','btn')}</section>`;
    }
    function overlay() {
      if(state.overlay==='p-rename')return modal(t('기획 이름 변경','Rename plan'),field(t('기획 이름','Plan name'),'p-title',form.title),cancel()+button('p-save-name',t('이름 저장','Save name'),'Check','btn primary'));
      if(state.overlay==='p-archive')return modal(t('기획을 보관할까요?','Archive this plan?'),`<p>${esc(entries.find(e=>e.id===state.overlayId)?.title)}</p><p>${t('기본 목록에서 숨깁니다. 문서와 대화, 결과는 남아 있으며 언제든 복원할 수 있습니다.','Hide it from the default list. Documents, conversations and results remain available for restoration.')}</p>`,cancel()+button('p-confirm-archive',t('보관','Archive'),'Archive','btn primary'));
      if(state.overlay==='p-rework')return modal(t('수정할 내용 정리','Describe the revisions'),field(t('수정 요청','Revision request'),'p-reason',form.reason,true)+`<p>${t('현재 결과와 검토 기록을 남기고 기획 문서로 돌아갑니다.','Keep this result and review history, then return to the plan document.')}</p>`,cancel()+button('p-confirm-rework',t('기획으로 돌아가기','Return to plan'),'ArrowLeft','btn primary'));
      if(state.overlay==='p-history')return modal(t('이전 결과와 수정 요청','Previous result and revision request'),current().history.map(h=>`<section><h3>${t('결과 r1 · 수정 요청','Result r1 · Revisions requested')}</h3><p>${esc(h.reason)}</p><pre class="flow-source-text">${esc(h.plan)}</pre><small>${t('예시 결과 · 실제 저장소 변경 없음','Sample result · No real repository changes')}</small></section>`).join(''),button('close',t('닫기','Close'),'X'));
      return engine().overlay();
    }
    function createPlan() {
      const source=form.linkSession&&state.sessions[form.linkSession];
      const entry=form.target&&form.target!=='new'?entries.find(e=>e.id===form.target):addEntry(`new-${++counter}`,form.title?.trim()||t('제목 없는 기획','Untitled plan'),form.purpose?.trim()||'');
      if(!entry)return; selected=entry.id; view='detail';state.overlay=null;
      if(source){entry.engine.attach(source);source.planSummary=form.purpose;state.sessionId=source.id;state.provider=source.provider;state.route='chat';state.scene='plans-linked';render();document.getElementById('draft')?.focus();}
      else {entry.engine.jump('planning');document.getElementById('flow-document')?.focus();}
      updateUrl();toast(t('기획에 연결했습니다. (시안)','Connected to the plan. (Simulation)'));
    }
    function action(action,node) {
      const id=node?.dataset.id;
      if(action==='session'){capture();selected=state.sessions[id]?.workflow?.planId||null;view='detail';return false;}
      if(action==='new-chat'){capture();selected=null;view='detail';return false;}
      if(action==='chat'){capture();selected=session()?.workflow?.planId||null;view='detail';return false;}
      if(['extensions','mcp','market'].includes(action))capture();
      if(action==='j-area'){
        if(id==='overview'){capture();selected=null;route('home','plans-home');return true;}
        if(!current()){collectionArea=id;route('list','plans-list');return true;}
      }
      if(action==='j-last-chat'&&!current()){state.route='chat';state.overlay=null;render();return true;}
      const frozen=current()?.status==='archived';
      if(frozen&&['j-save-document','j-apply-proposal','j-propose','j-prepare','j-start','j-confirm-start','j-start-review','j-integrate'].includes(action)){toast(t('기획을 먼저 복원하세요.','Restore the plan first.'));return true;}
      if(!action.startsWith('p-'))return engine().action(action,node);
      switch(action){
        case 'p-home':capture();selected=null;route('home','plans-home');break;
        case 'p-rename':form.title=current()?.title||'';openOverlay('p-rename');break;
        case 'p-save-name':{const item=current();if(item){item.title=form.title?.trim()||t('제목 없는 기획','Untitled plan');item.engine.rename(item.title);}state.overlay=null;render();break;}
        case 'p-list':capture();selected=null;collectionArea='planning';route('list','plans-list');break;
        case 'p-new':prior={view,selected,sessionId:state.sessionId,route:state.route};form={title:'',purpose:'',target:'new'};route('new','plans-new');document.getElementById('p-title')?.focus();break;
        case 'p-open':openEntry(id);break;
        case 'p-clear':search='';filter='active';render();break;
        case 'p-cancel':{const target=prior;prior=null;if(target){capture();view=target.view;selected=target.selected;state.sessionId=target.sessionId;state.route=target.route;state.overlay=null;render();}else{selected=null;route('list','plans-list');}break;}
        case 'p-create':createPlan();break;
        case 'p-link':capture();prior={view,selected,sessionId:state.sessionId,route:state.route};form={title:'',purpose:session().messages.filter(m=>m.role==='user').at(-1)?.text||session().draft,linkSession:state.sessionId,target:'new'};route('new','plans-new');break;
        case 'p-quick':prior={view,selected,sessionId:state.sessionId,route:state.route};form={title:'',purpose:'',path:'src/',acceptance:''};route('quick','plans-quick');break;
        case 'p-quick-create':{
          if(!form.purpose?.trim()||!form.path?.trim()||!form.acceptance?.trim()){document.getElementById('p-form-error').textContent=t('목적, 대상 경로와 완료 조건을 입력하세요.','Enter a goal, target path and acceptance criteria.');break;}
          const entry=addEntry(`quick-${++counter}`,form.title?.trim()||t('빠른 작업','Quick task'),`${form.purpose}\n${t('대상','Target')}: ${form.path}\n${t('완료 조건','Acceptance')}: ${form.acceptance}`,{quick:true});
          selected=entry.id;view='detail';entry.engine.jump('tasks');break;
        }
        case 'p-archive':{
          const item=entries.find(e=>e.id===id),status=item.engine.inspect().taskStatus;
          if(['waiting','working','paused','prepared'].includes(status)){toast(t('진행 중이거나 준비한 작업을 먼저 확인하세요.','Resolve the active or prepared task first.'));break;}
          openOverlay('p-archive',id);break;
        }
        case 'p-confirm-archive':{const item=entries.find(e=>e.id===state.overlayId);if(item)item.status='archived';state.overlay=null;selected=null;route('list','plans-list');toast(t('기획을 보관했습니다.','Plan archived.'));break;}
        case 'p-restore':{const item=entries.find(e=>e.id===id);if(item)item.status='active';filter='active';render();break;}
        case 'p-rework':form.reason=t('모바일 키보드가 열린 상태의 오류 안내도 확인해 주세요.','Also check error feedback with the mobile keyboard open.');openOverlay('p-rework');break;
        case 'p-confirm-rework':{const item=current();if(!item)break;item.history.push({reason:form.reason||'',plan:item.engine.inspect().planSaved});item.engine.rework();break;}
        case 'p-history':openOverlay('p-history');break;
      }
      return true;
    }
    document.addEventListener('input',event=>{
      const id=event.target.id;
      if(id==='flow-document')engine().capture();
      if(['p-title','p-purpose','p-path','p-acceptance','p-reason'].includes(id))form[id.slice(2)]=event.target.value;
      if(id==='p-search'){search=event.target.value;const pos=event.target.selectionStart;render();const input=document.getElementById(id);input?.focus();if(input&&input.type!=='search')input.setSelectionRange(pos,pos);}
    });
    document.addEventListener('change',event=>{if(event.target.id==='p-filter'){filter=event.target.value;render();}if(event.target.id==='p-target'){form.target=event.target.value;render();}});
    return {reset,tabs,sidebar,page,context,overlay,action,
      compact:()=>engine().compact(),compactComposer:()=>engine().compactComposer(),branch:()=>engine().branch(),areaLabel:()=>view==='detail'?engine().areaLabel():view==='quick'?stageLabel('tasks'):view==='home'?stageLabel('overview'):stageLabel('planning'),
      preview:()=>engine().preview(),welcome:()=>engine().welcome(),resultCard:()=>engine().resultCard(),hasContext:()=>engine().hasContext(),label:()=>engine().label(),startResponse:s=>(entries.find(e=>e.id===s.workflow?.planId)?.engine||fallback).startResponse(s),
      afterRender:()=>{engine().afterRender();if(current()?.status==='archived'){document.querySelectorAll('.flow-editor textarea, #draft').forEach(input=>input.readOnly=true);const send=document.getElementById('send');if(send)send.disabled=true;}},
      inspect:()=>({...engine().inspect(),selectedPlanId:current()?.id||null,view,plans:entries.map(({engine,...item})=>({...item,workflow:engine.inspect()}))})
    };
  };
})();
