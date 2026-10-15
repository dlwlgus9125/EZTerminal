/* r4 review surface: project siblings, editable workflows and the shared r3 conversation. */
(() => {
  const previous = window.createJourney, M = window.WORKFLOW_REVIEW;
  const sceneNames = [
    ['home','프로젝트 · 소프로젝트와 일반 대화','Project · Subprojects and conversations'],
    ['empty','빈 프로젝트에서 시작','Start in an empty project'],
    ['new','프리셋으로 소프로젝트 만들기','Create from a preset'],
    ['compose','대화로 흐름 구성하기','Compose a workflow in conversation'],
    ['graph','단계와 연결선 편집','Edit stages and connections'],
    ['parallel','병렬 작업 흐름','Parallel workflow'],
    ['stage','단계의 문서와 여러 대화','Stage documents and conversations'],
    ['chat','단계에서 이어가는 대화','Continue a stage conversation'],
    ['general','기획 없는 일반 대화','General conversation without a plan'],
    ['assistant','AI로 흐름 직접 편집','Edit the workflow with AI'],
    ['running','실행 버전과 편집 초안','Running version and editable draft'],
    ['approval','노드의 승인 대기','Approval at a node'],
    ['invalid','끊어진 연결 확인','Validate a disconnected workflow']
  ];
  window.CHAT_REVIEW.scenes.forEach(s => s.group = ['이전 r1–r3 비교', 'Earlier r1–r3 comparison']);
  window.CHAT_REVIEW.scenes.unshift(...sceneNames.map(([id,ko,en]) => ({id:`work-${id}`,name:[ko,en],group:['r4 소프로젝트와 흐름','r4 Subprojects and workflows'],description:['프로젝트에서 대화하거나 흐름을 만들고 단계별로 이어갑니다.','Start a conversation or build a workflow and continue at each stage.']})));
  window.createJourney = api => {
    const legacy = previous(api);
    const {state, session, t, esc, icon, button:b, badge, modal, cancel, openOverlay, render, captureView, updateUrl, freshSession, toast} = api;
    let enabled=false, projects=[], selected=null, view='home', nodeId=null, form={}, formGraph=null, editor={}, seq=0, search='', filter='all', graphMode='graph', outcome='pass', runTab=false, historyView=false;
    const current = () => projects.find(p => p.id === (state.route === 'chat' ? session()?.flowScope?.subprojectId : selected));
    const scope = () => session()?.flowScope;
    const graph = () => current()?.graph;
    const activeNode = () => graph()?.nodes.find(n=>n.id===nodeId);
    const tr = pair => pair[state.lang==='en'?1:0];
    const types = {stage:['AI 작업','AI task'],condition:['조건 분기','Condition'],fork:['병렬 시작','Parallel start'],join:['모두 기다리기','Wait for all'],approval:['사용자 승인','Human approval'],finish:['완료','Finish']};
    const presets = {feature:['기능 개발','Feature'],bug:['문제 수정','Bug fix'],research:['조사·정리','Research'],parallel:['병렬 구현','Parallel build'],blank:['직접 구성','Start simple']};
    const statusLabel = status => ({running:t('실행 중','Running'),waiting:t('승인 대기','Awaiting approval'),blocked:t('확인 필요','Needs attention'),completed:t('완료','Completed'),paused:t('일시정지','Paused'),cancelled:t('중단됨','Stopped')})[status]||status;
    const field = (id,label,value='',multiline=false) => `<label class="wf-field" for="${id}"><span>${esc(label)}</span>${multiline?`<textarea id="${id}" rows="4" maxlength="4000">${esc(value)}</textarea>`:`<input id="${id}" maxlength="180" value="${esc(value)}">`}</label>`;
    const select = (id,label,options,value) => `<label class="wf-field" for="${id}"><span>${esc(label)}</span><select id="${id}">${options.map(([v,label])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
    const nodeOptions = g => g.nodes.map(n=>[n.id,n.title]);
    function saveView() {captureView();}
    function show(next, scene) {
      saveView(); if(next)view=next; state.route='stage'; state.overlay=null;
      if(scene)state.scene=scene; updateUrl();render();document.getElementById('content')?.focus({preventScroll:true});
    }
    function addProject(title,purpose,kind='feature',g=null) {
      const p={id:`sub-${++seq}`,title,purpose,graph:M.clone(g||M.preset(kind,state.lang==='en')),documents:{},drafts:{},history:[],undo:[],removed:[],runs:[],archived:false};
      p.graph.nodes[0].brief=purpose; projects.push(p); return p;
    }
    function change(p,label,fn) {
      const record={label,graph:M.clone(p.graph),documents:M.clone(p.documents)};p.history.push(record);p.undo.push(record);fn(p.graph);p.graph.revision++;historyView=false;
    }
    function openProject(id) {saveView();selected=id;nodeId=null;runTab=false;historyView=false;show('flow','work-graph');}
    function openNode(id) {nodeId=id;runTab=false;show('node','work-stage');}
    function createChat(p=null,n=null,mode='stage',run=null) {
      const id=`work-chat-${++seq}`, s=freshSession(id,n?.provider||state.provider);
      s.title=n?`${n.title} · ${t('새 대화','New conversation')}`:p?`${p.title} · ${t('흐름 편집','Workflow editing')}`:t('새 일반 대화','New general conversation');
      if(p)s.flowScope={projectId:'ezterminal',subprojectId:p.id,nodeId:n?.id||null,mode,referenceRevision:p.graph.revision,referenceText:n?(p.documents[n.id]??n.brief??''):p.purpose,runId:run?.id||null};
      else s.rootConversation=true;
      if(mode==='graph')s.selected=['ezterminal-workflow'];
      state.sessions[id]=s;return s;
    }
    function openSession(id) {saveView();state.sessionId=id;state.provider=session().provider;selected=scope()?.subprojectId||null;nodeId=scope()?.nodeId||null;state.route='chat';state.overlay=null;state.scene=scope()?(scope().mode==='graph'?'work-assistant':'work-chat'):'work-general';updateUrl();render();document.getElementById('draft')?.focus({preventScroll:true});}
    const related = (p,id,mode='stage') => Object.values(state.sessions).filter(s=>s.flowScope?.subprojectId===p.id && s.flowScope.nodeId===id && s.flowScope.mode===mode);
    function talk(p,n,mode='stage',fresh=false,run=null) {
      const existing=related(p,n?.id||null,mode).findLast(s=>s.flowScope.runId===(run?.id||null));
      openSession((!fresh&&existing?existing:createChat(p,n,mode,run)).id);
    }
    function reset(scene) {
      legacy.reset(scene);enabled=scene.startsWith('work-'); if(!enabled)return;
      projects=[];selected=null;nodeId=null;view='home';seq=0;form={};editor={};search='';filter='all';outcome='pass';runTab=false;historyView=false;graphMode=state.device==='mobile'?'list':'graph';
      for(const provider of ['codex','claude'])state.catalogs[provider].unshift({id:'ezterminal-workflow',name:'ezterminal-workflow',token:'ezterminal-workflow',description:['소프로젝트 흐름 조회·편집·검증. 실행은 별도로 시작합니다.','Read, edit and validate subproject workflows. Start runs separately.'],source:'EZTerminal',kind:'project',icon:'GitBranch'});
      if(scene!=='work-empty') {
        addProject(t('로그인 경험 개선','Improve the login experience'),t('오류 안내와 키보드 조작을 개선한다.','Improve error feedback and keyboard access.'));
        addProject(t('결제 수단 추가','Add payment methods'),t('화면과 API를 나누어 구현하고 함께 검토한다.','Build the UI and API in parallel, then review them together.'),'parallel');
        const s=state.sessions['draft-1'];s.rootConversation=true;s.title=t('프로젝트 구조 살펴보기','Explore the project structure');
        const other=createChat();other.title=t('배포 방법 질문','Deployment questions');
      }
      state.route='stage';
      if(['work-new','work-compose'].includes(scene)) {view='new';form={title:'',purpose:'',preset:'feature',method:scene==='work-compose'?'chat':'preset',request:'',transcript:[]};formGraph=M.preset('feature',state.lang==='en');}
      if(['work-graph','work-parallel','work-stage','work-chat','work-assistant','work-running','work-approval','work-invalid'].includes(scene)) {
        selected=projects[scene==='work-parallel'?1:0].id;view='flow';nodeId=graph().entry;
        if(scene==='work-stage')view='node';
        if(scene==='work-chat') {const s=createChat(current(),activeNode());state.sessionId=s.id;state.route='chat';}
        if(scene==='work-assistant') {const s=createChat(current(),null,'graph');state.sessionId=s.id;state.route='chat';s.draft=t('디자인 단계는 빼고 보안 검토를 추가해줘','Remove design and add security review');}
        if(['work-running','work-approval'].includes(scene)) {
          const p=current(),r=M.createRun(p.graph,`run-${++seq}`);p.runs.push(r);runTab=true;
          if(scene==='work-approval')for(let i=0;i<20 && r.status==='running';i++)M.advance(r);
          else {M.advance(r);change(p,t('다음 실행의 단계 이름 변경','Rename a stage for the next run'),g=>g.nodes.find(n=>n.id==='build').title=t('구현 보완','Refine implementation'));}
        }
        if(scene==='work-invalid')graph().edges=graph().edges.filter(e=>e.from!=='plan');
      }
      if(scene==='work-general') {state.route='chat';state.sessionId='draft-1';}
      state.scene=scene;
    }
    function siblingRows(compact=false) {
      const items=[...projects.filter(p=>filter==='archived'?p.archived:!p.archived).map(p=>({kind:'sub',id:p.id,title:p.title,detail:p.archived?t('소프로젝트 · 보관됨','Subproject · Archived'):`${t('소프로젝트','Subproject')} · ${p.graph.nodes.length} ${t('단계','stages')}`})),...Object.values(state.sessions).filter(s=>s.rootConversation&&!s.flowScope&&filter!=='archived').map(s=>({kind:'chat',id:s.id,title:s.title||t('새 일반 대화','New conversation'),detail:t('일반 대화 · 기획 없음','General conversation · No plan')}))].filter(item=>(filter!=='sub'||item.kind==='sub')&&(filter!=='chat'||item.kind==='chat')&&item.title.toLowerCase().includes(search.toLowerCase()));
      return items.length?`<div class="${compact?'session-list':'wf-sibling-list'}" role="list">${items.map(item=>`<div role="listitem" class="wf-sibling" data-kind="${item.kind}"><button class="${compact?'session-row':'wf-item'} ${item.kind==='sub'&&current()?.id===item.id||item.kind==='chat'&&state.sessionId===item.id&&state.route==='chat'?'active':''}" data-action="${item.kind==='sub'?'wf-open':'wf-session'}" data-id="${item.id}">${icon(item.kind==='sub'?'Folder':'MessageSquare')}<span><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span>${compact?'':icon('ChevronRight')}</button></div>`).join('')}</div>`:`<p class="wf-empty">${search?t('검색 결과가 없습니다.','No matching items.'):t('소프로젝트를 만들거나 일반 대화를 시작하세요.','Create a subproject or start a conversation.')}</p>`;
    }
    function sidebar() {
      return `<aside class="sidebar wf-sidebar" aria-label="${t('프로젝트의 소프로젝트와 일반 대화','Subprojects and general conversations')}"><div class="row project-name">${icon('FolderOpen')} EZTerminal</div><div class="actions">${b('wf-new',t('소프로젝트','Subproject'),'Plus')}${b('new-chat',t('대화','Chat'),'Plus')}</div><div class="wf-side-list">${siblingRows(true)}</div><div class="sidebar-footer"><strong>WORKSTATION</strong><small>${t('같은 프로젝트 · 각각 이어가기','One project · Continue each item')}</small></div></aside>`;
    }
    function tabs() {
      const p=current();return `<nav class="wf-breadcrumb" aria-label="${t('현재 위치','Current location')}">${b('wf-home','EZTerminal','Folder','btn ghost')}${p?`${icon('ChevronRight')}${b('wf-open',p.title,null,'btn ghost',`data-id="${p.id}"`)}${nodeId?`<span>/ ${esc(p.graph.nodes.find(n=>n.id===nodeId)?.title||t('보관된 단계','Archived stage'))}</span>`:''}`:`<span>/ ${t(state.route==='chat'?'일반 대화':'프로젝트',state.route==='chat'?'General conversation':'Project')}</span>`}<span class="grow"></span>${b('wf-new',t('새 소프로젝트','New subproject'),'Plus','btn')}${b('new-chat',t('새 대화','New chat'),'MessageSquare','btn')}</nav>`;
    }
    function headline(title,copy,actions='') {return `<div class="wf-heading"><div><h1>${esc(title)}</h1><p>${esc(copy)}</p></div><div class="actions">${actions}</div></div>`;}
    const graphSummary = g => g.nodes.map(n=>esc(n.title)).join(' <span aria-hidden="true">→</span> ');
    function creation() {
      return headline(t('새 소프로젝트','New subproject'),t('목표와 시작 방식을 정하세요. 만든 뒤에도 흐름을 바꿀 수 있습니다.','Choose a goal and a starting point. You can edit the workflow later.'))+
        `<div class="wf-create-grid"><section class="wf-form">${field('wf-title',t('이름','Name'),form.title)}${field('wf-purpose',t('목표','Goal'),form.purpose,true)}<div class="segmented">${b('wf-method',t('프리셋 선택','Choose a preset'),null,'',`data-id="preset" aria-pressed="${form.method==='preset'}"`)}${b('wf-method',t('대화로 구성','Build through conversation'),null,'',`data-id="chat" aria-pressed="${form.method==='chat'}"`)}</div>${form.method==='preset'?`<div class="wf-presets">${Object.entries(presets).map(([id,label])=>b('wf-preset',tr(label),id==='parallel'?'GitBranch':'Layers','btn',`data-id="${id}" aria-pressed="${form.preset===id}"`)).join('')}</div>`:`<div class="wf-mini-transcript">${form.transcript.map(m=>`<p><strong>${m.role==='user'?t('나','You'):t('AI 예시','AI example')}</strong> ${esc(m.text)}</p>`).join('')}</div>${field('wf-request',t('원하는 흐름','Describe the workflow'),form.request,true)}<div class="actions">${b('wf-compose-example',t('화면·API 병렬 구현','Build UI and API in parallel'),'GitBranch')}${b('wf-compose',t('흐름 구성하기','Compose workflow'),'Send','btn primary')}</div><small>${t('시안은 병렬 구현·조사·디자인 제외·보안 검토 추가 요청을 예시 응답으로 처리합니다.','The prototype recognizes parallel build, research, remove design and add security review examples.')}</small>`}<p id="wf-form-error" role="alert"></p><div class="actions">${b('wf-cancel',t('취소','Cancel'),'X')}${b('wf-create',form.linkSession?t('만들고 대화 연결','Create and link conversation'):t('소프로젝트 만들기','Create subproject'),'Plus','btn primary')}</div></section><section class="wf-create-preview"><h2>${t('시작할 흐름','Starting workflow')}</h2><p class="muted">${t('아직 생성하지 않은 초안입니다.','This draft has not been created yet.')}</p>${stageList(formGraph,false)}<p class="wf-note">${t('프리셋은 시작점입니다. 단계·담당 AI·조건·승인을 이후에도 편집할 수 있습니다.','Presets are starting points. Edit stages, agents, conditions and approvals at any time.')}</p></section></div>`;
    }
    function stageList(g,interactive=true,r=null) {
      return `<ol class="wf-stages">${g.nodes.map((n,index)=>`<li><${interactive?'button':'div'} ${interactive?`data-action="${r?'wf-run-node':'wf-node'}" data-id="${n.id}"`:''} class="wf-stage-row"><span class="wf-index">${index+1}</span><span class="grow"><strong>${esc(n.title)}</strong><small>${esc(tr(types[n.type]))}${r?` · ${r.active.includes(n.id)?t('현재 단계','Current stage'):r.completed.includes(n.id)?t('진행 기록 있음','Has history'):t('대기','Pending')}`:''}</small><small>${g.edges.filter(e=>e.from===n.id).map(e=>`${e.when==='always'?'':e.when==='pass'?t('통과: ','Pass: '):t('실패: ','Fail: ')}${esc(g.nodes.find(n=>n.id===e.to)?.title||e.to)}`).join(' · ')}</small></span>${interactive?icon('ChevronRight'):''}</${interactive?'button':'div'}></li>`).join('')}</ol>`;
    }
    function diagram(g,r=null) {
      const positions=Object.fromEntries(g.nodes.map((n,i)=>[n.id,{x:30+(i%3)*230,y:30+Math.floor(i/3)*155}]));
      const height=Math.max(250,Math.ceil(g.nodes.length/3)*155+35);
      const wire=e=>{
        const a=positions[e.from],z=positions[e.to];if(!a||!z)return '';
        let d,labelX,labelY;
        if(a.y===z.y&&z.x>a.x){const y=a.y+44;d=`M ${a.x+180} ${y} L ${z.x} ${y}`;labelX=a.x+184;labelY=y-9;}
        else if(z.y>a.y){const mid=a.y+122;d=`M ${a.x+90} ${a.y+88} V ${mid} H ${z.x+90} V ${z.y}`;labelX=(a.x+z.x)/2+90;labelY=mid-8;}
        else {const mid=a.y-29;d=`M ${a.x+140} ${a.y} V ${mid} H ${z.x+140} V ${z.y+88}`;labelX=(a.x+z.x)/2+140;labelY=mid-8;}
        return `<path class="${e.when==='fail'?'wf-retry-wire':''}" d="${d}" marker-end="url(#wf-arrow)"/>${e.when!=='always'?`<text x="${labelX}" y="${labelY}">${e.when==='pass'?t('통과','Pass'):t('실패 · 재시도','Fail · Retry')}</text>`:''}`;
      };
      return `<div class="wf-canvas" tabindex="0" role="region" aria-label="${t('실행 흐름 그래프. 목록 보기로도 편집할 수 있습니다.','Workflow graph. Editing is also available in list view.')}"><div class="wf-canvas-content" style="width:730px;height:${height}px"><svg class="wf-wires" width="730" height="${height}" aria-hidden="true"><defs><marker id="wf-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="currentColor"/></marker></defs>${g.edges.map(wire).join('')}</svg>${g.nodes.map(n=>{const p=positions[n.id];return `<button class="wf-graph-node ${nodeId===n.id?'selected':''} ${r?.active.includes(n.id)?'running':''}" style="left:${p.x}px;top:${p.y}px" data-action="${r?'wf-run-node':'wf-select'}" data-id="${n.id}" aria-pressed="${nodeId===n.id}"><small>${icon(n.type==='stage'?'MessageSquare':n.type==='approval'?'ShieldCheck':'GitBranch')}${esc(tr(types[n.type]))}</small><strong>${esc(n.title)}</strong><span>${r?.active.includes(n.id)?t('현재 단계','Current stage'):n.type==='stage'?`${n.provider==='claude'?'Claude':'Codex'} · ${t('대화 열기','Open conversation')}`:n.type==='condition'?t('통과 / 실패','Pass / Fail'):n.type==='join'?t('모든 결과 도착 후','After all results arrive'):n.type==='approval'?t('사용자가 승인하면 진행','Continue after approval'):t('연결에 따라 진행','Follow connections')}</span></button>`;}).join('')}</div></div>`;
    }
    function validation(g) {
      const codes=M.validate(g),messages={entry:t('시작 단계를 선택하세요.','Choose a starting stage.'),finish:t('완료 노드가 필요합니다.','Add a finish node.'),output:t('연결이 없는 단계 또는 완료 이후 연결을 확인하세요.','Check disconnected stages or connections after finish.'),condition:t('분기에는 통과·실패 연결이 각각 필요합니다.','A condition needs one pass and one fail connection.'),'condition-port':t('조건 분기에만 통과·실패 연결을 사용하세요.','Use pass/fail ports only on conditions.'),fork:t('병렬 시작을 둘 이상의 단계에 연결하세요.','Connect parallel start to at least two stages.'),join:t('합류할 결과를 둘 이상 연결하세요.','Connect at least two results to the join.'),'single-output':t('여러 경로는 병렬 시작이나 분기 노드로 연결하세요.','Use a fork or condition for multiple paths.'),unreachable:t('시작점에서 도달하지 못하는 단계가 있습니다.','Some stages cannot be reached from the start.'),cycle:t('반복은 실패 분기와 재시도 한도로 구성하세요.','Use a failure branch and retry limit for loops.'),title:t('단계 이름이 필요합니다.','A stage needs a name.'),dangling:t('없는 단계로 향하는 연결이 있습니다.','A connection points to a missing stage.'),'duplicate-edge':t('중복된 연결을 제거하세요.','Remove duplicate connections.')};
      return codes.length?`<div class="notice warning wf-validation" role="status"><strong>${t('실행 전 연결을 확인하세요','Check connections before starting')}</strong><ul>${codes.map(code=>`<li>${esc(messages[code]||code)}</li>`).join('')}</ul></div>`:`<div class="wf-valid" role="status">${icon('CheckCheck')}${t('연결 확인됨','Connections checked')} · ${t('실패 시 최대 2회 재시도','At most 2 retries after failure')}</div>`;
    }
    function inspector(p) {
      const n=activeNode();return `<aside class="wf-inspector" aria-label="${t('선택한 단계 편집','Edit selected stage')}">${n?`<h2>${t('단계 편집','Edit stage')}</h2>${field('wf-node-title',t('단계 이름','Stage name'),editor.title??n.title)}${select('wf-node-type',t('노드 종류','Node type'),Object.entries(types).map(([id,label])=>[id,tr(label)]),editor.type??n.type)}${select('wf-node-provider',t('담당 AI','Agent'),[['codex','Codex'],['claude','Claude']],editor.provider??n.provider)}${field('wf-node-brief',t('지시·완료 조건','Instructions and acceptance'),editor.brief??n.brief,true)}<div class="actions">${b('wf-save-node',t('저장','Save'),'Check','btn primary')}${b('wf-node',t('문서·대화','Document and chat'),'MessageSquare','btn',`data-id="${n.id}"`)}</div><div class="actions">${b('wf-entry',t('시작점으로','Set as start'),'Play')}${b('wf-delete',t('단계 삭제','Delete stage'),'Trash2','btn danger')}</div>`:`<h2>${t('단계를 선택하세요','Select a stage')}</h2><p>${t('노드에서 이름·담당 AI·지시를 편집하고 같은 단계의 대화로 이동합니다.','Select a node to edit its name, agent and instructions, or open its conversation.')}</p>`}</aside>`;
    }
    function connections(p) {
      const g=p.graph;return `<details class="wf-connections"><summary>${t('연결 편집','Edit connections')} · ${g.edges.length}</summary><div class="wf-edge-list">${g.edges.map((e,i)=>`<div class="row"><span class="grow">${esc(g.nodes.find(n=>n.id===e.from)?.title||e.from)} → ${esc(g.nodes.find(n=>n.id===e.to)?.title||e.to)} <small>${e.when==='pass'?t('통과','Pass'):e.when==='fail'?t('실패 · 최대 2회','Fail · Max 2 retries'):t('완료 후','After completion')}</small></span>${b('wf-remove-edge',t('연결 삭제','Remove connection'),'X','btn',`data-id="${i}" aria-label="${esc(t('연결 삭제 ','Remove connection ')+String(i+1))}"`)}</div>`).join('')}</div><div class="wf-edge-form">${select('wf-edge-from',t('출발','From'),nodeOptions(g),editor.from||g.entry)}${select('wf-edge-to',t('도착','To'),nodeOptions(g),editor.to||g.nodes.at(-1)?.id)}${select('wf-edge-when',t('조건','Condition'),[['always',t('완료 후','After completion')],['pass',t('통과','Pass')],['fail',t('실패','Fail')]],editor.when||'always')}${b('wf-add-edge',t('연결 추가','Add connection'),'Link')}</div></details>`;
    }
    function flowPage(p) {
      const run=p.runs.at(-1),g=runTab&&run?run.graph:p.graph;
      return headline(p.title,p.purpose,`${b('wf-graph-chat',t('AI와 흐름 수정','Edit flow with AI'),'Sparkles')}${b('wf-history',t('변경 기록','Changes'),'History')}${b(p.archived?'wf-restore':'wf-archive',p.archived?t('복원','Restore'):t('보관','Archive'),'Archive')}`)+
        `<div class="wf-flow-bar"><div class="segmented">${b('wf-draft',`${t('편집 초안','Draft')} v${p.graph.revision}`,null,'',`aria-pressed="${!runTab}"`)}${run?b('wf-running',`${t('실행','Run')} v${run.graph.revision}`,null,'',`aria-pressed="${runTab}"`):''}</div><div class="actions">${b('wf-view',t('그래프','Graph'),'GitBranch','btn',`data-id="graph" aria-pressed="${graphMode==='graph'}"`)}${b('wf-view',t('목록','List'),'List','btn',`data-id="list" aria-pressed="${graphMode==='list'}"`)}${!runTab?b('wf-add-node',t('단계 추가','Add stage'),'Plus')+b('wf-undo',t('되돌리기','Undo'),'History','btn',p.undo.length?'':'disabled'):''}</div></div>${p.archived?`<div class="notice warning">${t('보관한 소프로젝트입니다. 복원 후 편집할 수 있습니다.','Archived subproject. Restore it to edit.')}</div>`:''}${run?`<div class="wf-run-banner">${badge(statusLabel(run.status),run.status==='waiting'?'warn':'')} <span>${t('시안 실행','Simulated run')} · v${run.graph.revision}${run.graph.revision!==p.graph.revision?' · '+t('초안 변경은 다음 실행부터 적용','Draft changes apply to the next run'):''}</span></div>`:''}${runTab?runControls(p,run):validation(g)}<div class="wf-graph-layout">${graphMode==='graph'?diagram(g,runTab?run:null):`<section class="wf-list-view">${stageList(g,true,runTab?run:null)}</section>`}${runTab?`<aside class="wf-inspector"><h2>${t('실행 기록','Run history')}</h2><p>${t('노드를 선택하면 이 실행에 연결된 대화를 엽니다.','Select a node to open its conversation for this run.')}</p>${(run?.events||[]).map(e=>`<p class="wf-event">${e.id}. ${esc(g.nodes.find(n=>n.id===e.nodeId)?.title)} · ${esc(e.outcome==='completed'?t('완료 예시','Example completion'):e.outcome==='pass'?t('통과','Pass'):e.outcome==='fail'?t('실패','Fail'):e.outcome==='approval-denied'?t('승인 거절','Approval denied'):t('재시도 한도','Retry limit'))}</p>`).join('')}</aside>`:inspector(p)}</div>${runTab?'':connections(p)}${!runTab?`<div class="wf-bottom-actions">${b('wf-start',t('실행 준비','Prepare run'),'Play','btn primary',M.validate(g).length||p.archived||run&&['running','waiting','paused'].includes(run.status)?'disabled':'')}<small>${t('시작할 버전·작업 위치·승인 단계를 확인합니다.','Review the version, workspace and approval stages before starting.')}</small></div>`:''}${historyView?`<section class="wf-history"><h2>${t('변경 기록','Changes')}</h2>${p.history.length?p.history.map(h=>`<p>v${h.graph.revision} → v${h.graph.revision+1} · ${esc(h.label)}</p>`).join(''):`<p>${t('아직 변경이 없습니다.','No changes yet.')}</p>`}${p.removed.map(n=>`<p>${t('보관된 단계','Archived stage')} · ${esc(n.title)} ${b('wf-removed-chats',t('관련 대화','Related conversations'),'MessageSquare','btn',`data-id="${n.id}"`)}</p>`).join('')}</section>`:''}`;
    }
    function approvalButtons(r) {
      return r.active.filter(id=>r.graph.nodes.find(n=>n.id===id)?.type==='approval'&&['running','waiting','paused'].includes(r.status)).map(id=>b('wf-approve',t('이 단계 승인','Approve this stage'),'ShieldCheck','btn primary',`data-id="${id}" ${r.status==='paused'?'disabled':''}`)+b('wf-deny',t('승인 거절','Deny approval'),'X','btn',`data-id="${id}" ${r.status==='paused'?'disabled':''}`)).join('');
    }
    function runControls(p,r) {
      if(!r)return '';return `<div class="wf-run-controls"><p>${t('연결선을 따르는 예시 실행입니다. 실제 AI·파일 작업은 수행하지 않습니다.','This simulation follows the connections. It runs no actual AI or file operations.')}</p><div class="actions">${select('wf-outcome',t('다음 검토 결과 예시','Next sample review outcome'),[['pass',t('통과','Pass')],['fail',t('실패','Fail')]],outcome)}${b('wf-tick',t('다음 진행 체험','Advance simulation'),'Play','btn',r.status==='running'?'':'disabled')}${approvalButtons(r)}${['running','waiting','paused'].includes(r.status)?b('wf-pause',r.status==='paused'?t('재개','Resume'):t('일시정지','Pause'),r.status==='paused'?'Play':'Square')+b('wf-stop',t('중단','Stop'),'X'):''}</div>${r.status==='blocked'?`<p class="warn">${r.blockReason==='approval-denied'?t('승인을 거절했습니다. 변경이 필요하면 초안을 편집하고 새 실행을 준비하세요.','Approval was denied. Edit the draft and prepare a new run if needed.'):t('재시도 한도에 도달했습니다. 초안을 수정한 뒤 새 실행을 준비하세요.','Retry limit reached. Edit the draft and prepare a new run.')}</p>`:''}</div>`;
    }
    function nodePage(p) {
      const n=activeNode();if(!n)return `<p>${t('단계는 보관됐으며 기존 대화는 기록에서 열 수 있습니다.','The stage is archived. Open existing conversations from history.')}</p>`;
      const chats=related(p,n.id);return headline(n.title,`${p.title} · ${tr(types[n.type])}`,b('wf-talk',t('대화 이어가기','Continue conversation'),'MessageSquare','btn primary')+b('wf-new-stage-chat',t('새 단계 대화','New stage conversation'),'Plus'))+`<div class="wf-stage-layout"><section class="wf-document">${field('wf-document',t('단계 문서·산출물','Stage document and output'),p.drafts[n.id]??p.documents[n.id]??n.brief,true)}<div class="actions">${b('wf-save-document',t('문서 저장','Save document'),'Check')}${b('wf-flow',t('흐름으로 돌아가기','Return to workflow'),'ArrowLeft')}</div><small>${t('대화와 문서는 같은 단계에 연결됩니다. 문서 편집은 저장 후 참조에 반영합니다.','Conversations and documents belong to this stage. Save edits before using them as a reference.')}</small></section><section class="wf-stage-chats"><h2>${t('이 단계의 대화','Conversations for this stage')}</h2>${chats.length?chats.map(s=>`<button class="session-row" data-action="wf-session" data-id="${s.id}">${icon('MessageSquare')}<span><strong>${esc(s.title)}</strong><small>${s.provider==='claude'?'Claude':'Codex'} · ${s.flowScope.runId?`${t('실행','Run')} ${esc(s.flowScope.runId)}`:t('단계 논의','Stage discussion')}</small></span></button>`).join(''):`<p>${t('첫 대화를 시작하세요. 단계를 열기만 해서는 메시지를 보내지 않습니다.','Start the first conversation. Opening a stage sends no message.')}</p>`}</section></div>`;
    }
    function page() {
      let body='';const p=current();
      if(view==='home')body=headline(t('프로젝트에서 이어가기','Continue in your project'),t('흐름이 필요한 일은 소프로젝트로, 궁금한 것은 일반 대화로 시작하세요.','Use a subproject for a workflow, or start a general conversation.'))+`<div class="wf-starts"><button data-action="wf-new">${icon('Folder')}<span><strong>${t('새 소프로젝트','New subproject')}</strong><small>${t('프리셋 또는 대화로 단계 구성','Choose a preset or compose through conversation')}</small></span>${icon('Plus')}</button><button data-action="new-chat">${icon('MessageSquare')}<span><strong>${t('새 일반 대화','New general conversation')}</strong><small>${t('기획 없이 바로 대화','Talk immediately, without a plan')}</small></span>${icon('Plus')}</button></div><div class="wf-collection-tools">${field('wf-search',t('이름 검색','Search by name'),search)}${select('wf-filter',t('보기','Show'),[['all',t('모두','All')],['sub',t('소프로젝트','Subprojects')],['chat',t('일반 대화','General conversations')],['archived',t('보관됨','Archived')]],filter)}</div>${siblingRows()}`;
      else if(view==='new')body=creation();
      else if(p)body=view==='node'?nodePage(p):flowPage(p);
      return `${tabs()}<div class="wf-page"><div class="wf-page-inner">${body}</div></div>`;
    }
    function context() {
      const p=current(),w=scope();if(!p||!w)return `<div class="wf-general-context"><span>${t('일반 대화 · 소프로젝트에 속하지 않음','General conversation · No subproject')}</span>${b('wf-link',t('소프로젝트에 연결','Link to a subproject'),'Link','btn ghost')}</div>`;
      const n=(w.runId?p.runs.find(r=>r.id===w.runId)?.graph:p.graph)?.nodes.find(n=>n.id===w.nodeId),old=p.removed.find(n=>n.id===w.nodeId);
      return `<section class="flow-context"><div class="flow-context-main">${b(w.mode==='graph'?'wf-flow':'wf-return-node',w.mode==='graph'?t('흐름으로 돌아가기','Return to workflow'):t('단계로 돌아가기','Return to stage'),'ArrowLeft')}<span class="context-copy"><strong>${esc(p.title)} / ${esc(w.mode==='graph'?t('흐름 편집','Workflow editing'):n?.title||old?.title||'')}</strong><small>${w.runId?`${t('실행','Run')} ${esc(w.runId)}`:`${t('참조','Reference')} v${w.referenceRevision}`}${!n&&old?' · '+t('보관된 단계','Archived stage'):''}</small></span>${w.mode==='graph'?badge('ezterminal-workflow','good'):b('wf-reference',t('참조 보기','View reference'),'FileText')}</div>${w.mode==='graph'?`<p>${t('AI가 편집 초안을 직접 수정합니다. 변경 기록·되돌리기를 제공하며 실행은 별도로 시작합니다.','AI edits the draft directly, with history and undo. Start execution separately.')}</p>`:w.referenceRevision!==p.graph.revision?`<div class="context-update">${t('초안이 바뀌었습니다. 이 대화의 참조는 유지됩니다.','The draft changed. This conversation retains its reference.')}${!w.runId&&n?b('wf-refresh-reference',t('최신 참조 사용','Use latest reference'),'RefreshCw','pill'):''}</div>`:''}</section>`;
    }
    function welcome() {
      const w=scope();return `<section class="welcome"><div class="welcome-mark">${icon(w?.mode==='graph'?'GitBranch':'MessageSquare')}</div><h2>${t(w?.mode==='graph'?'흐름을 어떻게 바꿀까요?':'이 단계에서 함께 살펴볼까요?',w?.mode==='graph'?'How should the workflow change?':'What shall we explore at this stage?')}</h2><p>${w?.mode==='graph'?t('디자인 제외, 보안 검토 추가, 실패 후 재검토를 요청해 보세요.','Try removing design, adding security review, or retrying after failed review.'):t('단계의 문서와 이전 논의를 참고해 대화를 이어갑니다.','Continue using this stage’s document and prior discussions.')}</p><div class="ready-row">${badge(t('첫 메시지 전 스킬 준비됨','Skills ready before the first message'),'good')}${b('skills',t('스킬 선택','Choose a skill'),'Sparkles')}</div>${w?.mode==='graph'?`<div class="actions">${b('wf-prompt',t('보안 검토 추가','Add security review'),'Plus','btn','data-id="security"')}${b('wf-prompt',t('실패하면 다시 수정','Retry after failure'),'RefreshCw','btn','data-id="retry"')}</div><p class="muted">${t('시안은 정해진 요청에 예시 응답을 표시합니다. 실제 AI 연결은 없습니다.','The prototype responds to example requests. No live AI is connected.')}</p>`:''}</section>`;
    }
    function preview() {
      const w=scope(),p=current();if(!w||!p)return '';return `<aside class="flow-reference"><h2>${w.mode==='graph'?t('현재 흐름','Current workflow'):t('참조 문서','Reference document')}</h2>${w.mode==='graph'?`<p class="wf-note">v${p.graph.revision} · ${graphSummary(p.graph)}</p>${b('wf-flow',t('그래프 열기','Open graph'),'GitBranch')}${b('wf-undo',t('마지막 변경 되돌리기','Undo last change'),'History','btn',p.undo.length?'':'disabled')}`:`<p class="reference-text">${esc(w.referenceText||t('아직 저장한 내용이 없습니다.','No saved content yet.'))}</p>`}</aside>`;
    }
    function overlay() {
      const p=current(),n=activeNode();
      if(state.overlay==='wf-frozen')return modal(t('이 실행의 AI 설정','AI settings for this run'),`<p>${t('실행을 시작할 때 확정한 설정입니다. 다음 실행의 설정은 편집 초안에서 바꿀 수 있습니다. 현재 대화와 실행 버전은 유지합니다.','These settings were frozen when the run started. Change the draft for the next run. This conversation and running version are preserved.')}</p>`);
      if(state.overlay==='wf-navigation')return modal(t('프로젝트 항목','Project items'),`${b('wf-home',t('프로젝트 열기','Open project'),'Folder')}${siblingRows()}<div class="actions">${b('wf-new',t('새 소프로젝트','New subproject'),'Plus')}${b('new-chat',t('새 일반 대화','New conversation'),'MessageSquare')}</div>`);
      if(state.overlay==='wf-delete')return modal(t('단계를 삭제할까요?','Delete this stage?'),`<p>${esc(n?.title)} · ${t('이 단계의 연결은 제거됩니다. 기존 대화·문서·실행 기록은 보관하며 변경 기록에서 다시 열 수 있습니다.','Connections will be removed. Conversations, documents and run history remain accessible in Changes.')}</p>`,cancel()+b('wf-confirm-delete',t('단계 삭제','Delete stage'),'Trash2','btn danger'));
      if(state.overlay==='wf-start')return modal(t('실행할 흐름 확인','Review the workflow to run'),`<p><strong>${esc(p.title)} · v${p.graph.revision}</strong></p><p class="wf-note">${graphSummary(p.graph)}</p><p>WORKSTATION / EZTerminal</p><p>${t('각 노드의 담당 AI·지시와 연결을 이 버전으로 고정합니다. 승인 노드에서는 기다립니다.','Freeze each node’s agent, instructions and connections at this version. Approval nodes wait for you.')}</p><div class="notice">${t('시안 체험: 실제 AI·파일·Git 작업을 수행하지 않습니다.','Prototype only: no real AI, file or Git operations.')}</div>`,cancel()+b('wf-confirm-start',t('이 버전으로 시작 체험','Simulate this version'),'Play','btn primary'));
      if(state.overlay==='wf-link') {
        const target=projects.find(p=>p.id===form.target)||projects.find(p=>!p.archived);
        return modal(t('대화를 소프로젝트에 연결','Link conversation to a subproject'),`<p>${t('같은 대화와 입력을 유지합니다. 문서를 덮어쓰거나 실행을 시작하지 않습니다.','Keep this conversation and its draft. No document is overwritten and no execution starts.')}</p>${target?`${select('wf-link-target',t('소프로젝트','Subproject'),projects.filter(p=>!p.archived).map(p=>[p.id,p.title]),target.id)}${select('wf-link-node',t('연결할 단계','Stage'),nodeOptions(target.graph),form.targetNode||target.graph.entry)}`:''}`,b('wf-link-new',t('새 소프로젝트로','Create a subproject'),'Plus')+(target?b('wf-confirm-link',t('선택한 단계에 연결','Link to selected stage'),'Link','btn primary'):''));
      }
      if(state.overlay==='wf-reference')return modal(t('대화의 참조','Conversation reference'),`<p class="reference-text">${esc(scope()?.referenceText||'')}</p>`);
      if(state.overlay==='wf-removed-chats')return modal(t('보관된 단계의 대화','Archived stage conversations'),related(p,state.overlayId).map(s=>b('wf-session',s.title,'MessageSquare','btn',`data-id="${s.id}"`)).join('')||`<p>${t('이 단계에서 만든 대화가 없습니다.','No conversations were created for this stage.')}</p>`);
      return '';
    }
    function editFromPrompt(g,text) {
      let changes=[];const lower=text.toLowerCase();
      if(/디자인.*(빼|제외|제거)|remove.*design|without.*design/.test(lower)) {
        const design=g.nodes.find(n=>n.id==='design');if(design){const incoming=g.edges.filter(e=>e.to===design.id),out=g.edges.filter(e=>e.from===design.id);g.nodes=g.nodes.filter(n=>n.id!==design.id);g.edges=g.edges.filter(e=>e.to!==design.id&&e.from!==design.id);incoming.forEach(a=>out.forEach(z=>g.edges.push({from:a.from,to:z.to,when:a.when})));changes.push(t('디자인 단계를 제외했습니다.','Removed the design stage.'));}
      }
      if(/보안|security/.test(lower)&&!g.nodes.some(n=>n.id==='security')) {
        const anchor=g.nodes.find(n=>n.id==='review')||g.nodes.find(n=>n.type==='finish'),id='security';
        g.nodes.splice(Math.max(0,g.nodes.indexOf(anchor)),0,{id,title:t('보안 검토','Security review'),type:'stage',provider:'claude',brief:t('변경한 범위의 보안과 입력 검증을 확인한다.','Review security and input validation within the changed scope.')});
        if(anchor){g.edges.forEach(e=>{if(e.to===anchor.id)e.to=id;});g.edges.push({from:id,to:anchor.id,when:'always'});if(g.entry===anchor.id)g.entry=id;}
        changes.push(t('보안 검토 단계를 연결했습니다.','Connected a security review stage.'));
      }
      if(/실패|다시|retry|fail/.test(lower)) {
        const condition=g.nodes.find(n=>n.type==='condition'),build=g.nodes.find(n=>n.id==='build');
        if(condition&&build&&!g.edges.some(e=>e.from===condition.id&&e.when==='fail')) {g.edges.push({from:condition.id,to:build.id,when:'fail'});changes.push(t('실패 후 구현으로 돌아가도록 연결했습니다.','Connected failure back to implementation.'));}
      }
      return changes;
    }
    function startResponse(s) {
      if(!enabled)return legacy.startResponse(s);
      const w=s.flowScope,p=projects.find(p=>p.id===w?.subprojectId),text=s.messages.filter(m=>m.role==='user').at(-1)?.text||'';
      let reply;
      if(w?.mode==='graph'&&p&&!p.archived) {
        const candidate=M.clone(p.graph),changes=editFromPrompt(candidate,text);
        if(changes.length) {change(p,changes.join(' '),g=>{p.removed.push(...g.nodes.filter(n=>!candidate.nodes.some(c=>c.id===n.id)));g.nodes=candidate.nodes;g.edges=candidate.edges;g.entry=candidate.entry;});reply=changes.join(' ')+t(' 초안에 반영했습니다. 실행 버전은 유지되며 되돌릴 수 있습니다.',' Updated the draft. The running version is preserved; you can undo this change.');}
        else reply=t('이 시안은 “디자인 단계를 빼고 보안 검토를 추가해줘”를 체험할 수 있습니다. 요청을 해석하지 못했거나 이미 반영된 경우 흐름을 바꾸지 않습니다.','Try “Remove design and add security review.” Unrecognized or already-applied requests leave the workflow unchanged.');
      } else if(!w&&s.messages.at(-1)?.skills?.includes('ezterminal-workflow'))reply=t('수정할 소프로젝트를 먼저 선택해 주세요. 일반 대화를 그대로 유지하거나 “소프로젝트에 연결”로 대상을 정할 수 있습니다.','Choose a subproject before editing a workflow. Keep this conversation general, or use Link to a subproject.');
      else reply=w?t('이 단계의 참조를 바탕으로 목표와 완료 조건을 함께 검토하겠습니다. 대화는 이 단계에 남고, 문서 반영과 실행 시작은 별도로 선택합니다. (예시 응답)','Let’s review this stage’s goal and acceptance criteria. This conversation stays with the stage; document changes and execution remain separate. (Example response)'):t('기획 없이 이 프로젝트에 대해 계속 대화할 수 있습니다. 필요해지면 나중에 소프로젝트에 연결하세요. (예시 응답)','We can keep discussing this project without a plan. Link it to a subproject later if useful. (Example response)');
      s.status='completed';s.messages.push({role:'assistant',text:reply});s.scroll=Number.MAX_SAFE_INTEGER;return true;
    }
    function linkSession(p,n) {
      const s=state.sessions[form.linkSession];if(!s)return;
      s.flowScope={projectId:'ezterminal',subprojectId:p.id,nodeId:n.id,mode:'stage',referenceRevision:p.graph.revision,referenceText:p.documents[n.id]??n.brief,runId:null};s.rootConversation=false;openSession(s.id);
    }
    function action(action,node) {
      if(!enabled)return legacy.action(action,node);
      const id=node?.dataset.id,p=current(),n=activeNode(),r=p?.runs.at(-1);
      if(scope()?.runId&&['model','permission','provider','choose-provider','save-model','save-permission'].includes(action)){openOverlay('wf-frozen');return true;}
      if(p?.archived&&['wf-save-node','wf-save-document','wf-add-node','wf-delete','wf-confirm-delete','wf-add-edge','wf-remove-edge','wf-entry','wf-undo','wf-start','wf-confirm-start','wf-graph-chat','wf-new-stage-chat','wf-talk'].includes(action)){toast(t('먼저 소프로젝트를 복원하세요.','Restore the subproject first.'));return true;}
      if(action==='new-chat'){saveView();openSession(createChat().id);return true;}
      if(action==='navigation'){openOverlay('wf-navigation');return true;}
      if(action==='j-area'){show('home','work-home');return true;}
      if(action==='chat'){state.route='chat';state.overlay=null;render();return true;}
      if(action==='session'){openSession(id);return true;}
      if(action==='choose-provider'&&session().messages.length&&session().provider!==id){const old=scope();saveView();const s=createChat(old?current():null,old?.nodeId?current().graph.nodes.find(n=>n.id===old.nodeId):null,old?.mode||'stage');s.provider=id;s.model=window.CHAT_REVIEW.providers[id].model;if(old)s.flowScope=M.clone(old);openSession(s.id);return true;}
      if(!action.startsWith('wf-'))return false;
      switch(action) {
        case 'wf-home':selected=null;show('home','work-home');break;
        case 'wf-open':openProject(id);break;
        case 'wf-session':openSession(id);break;
        case 'wf-new':saveView();selected=null;nodeId=null;form={title:'',purpose:'',preset:'feature',method:'preset',request:'',transcript:[]};formGraph=M.preset('feature',state.lang==='en');show('new','work-new');break;
        case 'wf-cancel':if(form.linkSession)openSession(form.linkSession);else{selected=null;show('home','work-home');}break;
        case 'wf-method':form.method=id;render();break;
        case 'wf-preset':form.preset=id;formGraph=M.preset(id,state.lang==='en');render();break;
        case 'wf-compose-example':form.request=t('화면과 API를 병렬로 구현하고 검토 후 승인받게 해줘','Build UI and API in parallel, then review and request approval');render();break;
        case 'wf-compose':{
          const text=form.request?.trim();if(!text)break;form.transcript.push({role:'user',text});
          if(/병렬|parallel/i.test(text))formGraph=M.preset('parallel',state.lang==='en');else if(/조사|research/i.test(text))formGraph=M.preset('research',state.lang==='en');
          const changes=editFromPrompt(formGraph,text),recognized=changes.length||/병렬|parallel|조사|research/i.test(text);
          form.transcript.push({role:'assistant',text:recognized?t('오른쪽 흐름 초안을 수정했습니다. 이름과 목표를 입력하고 생성할 수 있습니다.','Updated the workflow preview. Enter a name and goal to create it.'):t('이 시안에서는 병렬 구현·조사·디자인 제외·보안 검토 요청을 체험할 수 있습니다. 흐름은 그대로 유지했습니다.','Try parallel build, research, remove design or security review. The workflow is unchanged.')});form.request='';render();break;
        }
        case 'wf-create':if(!form.title?.trim()||!form.purpose?.trim()){document.getElementById('wf-form-error').textContent=t('이름과 목표를 입력하세요.','Enter a name and goal.');break;} {const added=addProject(form.title.trim(),form.purpose.trim(),form.preset,formGraph);if(form.linkSession)linkSession(added,added.graph.nodes[0]);else openProject(added.id);}break;
        case 'wf-select':nodeId=id;editor={};render();break;
        case 'wf-node':openNode(id);break;
        case 'wf-return-node':selected=scope()?.subprojectId;nodeId=scope()?.nodeId;if(scope()?.runId){runTab=true;show('flow','work-running');}else show('node','work-stage');break;
        case 'wf-flow':selected=p?.id;show('flow','work-graph');break;
        case 'wf-talk':talk(p,n);break;
        case 'wf-new-stage-chat':talk(p,n,'stage',true);break;
        case 'wf-graph-chat':talk(p,null,'graph');break;
        case 'wf-prompt':session().draft=id==='security'?t('보안 검토를 추가해줘','Add security review'):t('검토 실패 시 다시 수정하게 해줘','Retry implementation when review fails');session().selection=[session().draft.length,session().draft.length];render();break;
        case 'wf-save-node':if(!(editor.title??n.title).trim()){toast(t('단계 이름을 입력하세요.','Enter a stage name.'));break;}change(p,t('단계 설정 수정','Edit stage settings'),()=>Object.assign(n,{title:editor.title??n.title,type:editor.type??n.type,provider:editor.provider??n.provider,brief:editor.brief??n.brief}));editor={};render();break;
        case 'wf-save-document':change(p,t('단계 문서 저장','Save stage document'),()=>{p.documents[n.id]=p.drafts[n.id]??p.documents[n.id]??n.brief;n.brief=p.documents[n.id];});render();toast(t('단계 문서를 저장했습니다.','Stage document saved.'));break;
        case 'wf-add-node':{const newId=`node-${++seq}`;change(p,t('단계 추가','Add stage'),g=>g.nodes.push({id:newId,title:t('새 단계','New stage'),type:'stage',brief:'',provider:'codex'}));nodeId=newId;editor={};render();break;}
        case 'wf-entry':change(p,t('시작 단계 변경','Change start stage'),g=>g.entry=n.id);render();break;
        case 'wf-delete':openOverlay('wf-delete');break;
        case 'wf-confirm-delete':change(p,t('단계 삭제 · 기록 보관','Delete stage · Retain history'),g=>{p.removed.push(M.clone(n));g.nodes=g.nodes.filter(x=>x.id!==n.id);g.edges=g.edges.filter(e=>e.from!==n.id&&e.to!==n.id);});nodeId=null;state.overlay=null;render();break;
        case 'wf-add-edge':{const edge={from:editor.from||p.graph.entry,to:editor.to||p.graph.nodes.at(-1)?.id,when:editor.when||'always'};if(!edge.to)break;change(p,t('연결 추가','Add connection'),g=>g.edges.push(edge));render();break;}
        case 'wf-remove-edge':change(p,t('연결 삭제','Remove connection'),g=>g.edges.splice(Number(id),1));render();break;
        case 'wf-view':graphMode=id;render();break;
        case 'wf-draft':runTab=false;render();break;
        case 'wf-running':runTab=true;render();break;
        case 'wf-undo':{const h=p.undo.pop();if(h){const rev=p.graph.revision+1;p.history.push({label:t('되돌리기: ','Undo: ')+h.label,graph:M.clone(p.graph),documents:M.clone(p.documents)});p.graph=M.clone(h.graph);p.documents=M.clone(h.documents);p.graph.revision=rev;nodeId=p.graph.nodes.some(n=>n.id===nodeId)?nodeId:null;editor={};}render();break;}
        case 'wf-history':historyView=!historyView;runTab=false;show('flow','work-graph');break;
        case 'wf-removed-chats':openOverlay('wf-removed-chats',id);break;
        case 'wf-start':if(!M.validate(p.graph).length)openOverlay('wf-start');break;
        case 'wf-confirm-start':{if(r&&['running','waiting','paused'].includes(r.status))break;const run=M.createRun(p.graph,`run-${++seq}`);if(run){p.runs.push(run);runTab=true;state.overlay=null;render();}break;}
        case 'wf-tick':M.advance(r,outcome);render();break;
        case 'wf-approve':M.advance(r,outcome,id);render();break;
        case 'wf-deny':if(r&&['running','waiting'].includes(r.status)){r.status='blocked';r.blockReason='approval-denied';r.events.push({id:++r.sequence,nodeId:id,outcome:'approval-denied'});}render();break;
        case 'wf-pause':if(r){r.status=r.status==='paused'?(r.beforePause||'running'):(r.beforePause=r.status,'paused');}render();break;
        case 'wf-stop':if(r)r.status='cancelled';render();break;
        case 'wf-run-node':{const rn=r?.graph.nodes.find(n=>n.id===id);if(rn){const savedRun=r;talk(p,rn,'stage',false,savedRun);session().flowScope.referenceRevision=savedRun.graph.revision;session().flowScope.referenceText=rn.brief;render();}break;}
        case 'wf-reference':openOverlay('wf-reference');break;
        case 'wf-refresh-reference':if(scope()&&!scope().runId){const target=p.graph.nodes.find(n=>n.id===scope().nodeId);if(target){scope().referenceRevision=p.graph.revision;scope().referenceText=p.documents[target.id]??target.brief;}}render();break;
        case 'wf-link':form={linkSession:state.sessionId,target:projects.find(p=>!p.archived)?.id,targetNode:null};openOverlay('wf-link');break;
        case 'wf-confirm-link':{const target=projects.find(p=>p.id===form.target);if(target&&!target.archived){const n=target.graph.nodes.find(n=>n.id===(form.targetNode||target.graph.entry));if(n)linkSession(target,n);}break;}
        case 'wf-link-new':form={title:'',purpose:'',preset:'feature',method:'preset',request:'',transcript:[],linkSession:form.linkSession};formGraph=M.preset('feature',state.lang==='en');show('new','work-new');break;
        case 'wf-archive':if(r&&['running','waiting','paused'].includes(r.status)){toast(t('실행을 마치거나 중단한 뒤 보관하세요.','Finish or stop the run before archiving.'));break;}p.archived=true;selected=null;show('home','work-home');break;
        case 'wf-restore':p.archived=false;render();break;
      }
      return true;
    }
    document.addEventListener('input',event=>{
      if(!enabled)return;const id=event.target.id,value=event.target.value;
      if(['wf-title','wf-purpose','wf-request'].includes(id))form[id.slice(3)]=value;
      if(id.startsWith('wf-node-'))editor[id.slice(8)]=value;
      if(id==='wf-document'&&current()&&nodeId)current().drafts[nodeId]=value;
      if(id==='wf-search'){search=value;const position=event.target.selectionStart;render();const input=document.getElementById(id);input.focus();input.setSelectionRange(position,position);}
    });
    document.addEventListener('change',event=>{
      if(!enabled)return;const id=event.target.id,value=event.target.value;
      if(id==='wf-filter'){filter=value;render();}
      if(id.startsWith('wf-node-'))editor[id.slice(8)]=value;
      if(id.startsWith('wf-edge-'))editor[id.slice(8)]=value;
      if(id==='wf-outcome')outcome=value;
      if(id==='wf-link-target'){form.target=value;form.targetNode=null;render();}
      if(id==='wf-link-node')form.targetNode=value;
    });
    function afterRender() {
      if(!enabled){legacy.afterRender();return;}
      if(current()?.archived){document.querySelectorAll('#draft,#wf-document').forEach(n=>n.readOnly=true);const send=document.getElementById('send');if(send)send.disabled=true;}
      if(scope()?.runId&&state.route==='chat')document.querySelectorAll('[data-action="model"],[data-action="permission"],[data-action="provider"]').forEach(n=>n.disabled=true);
    }
    return {reset,action,startResponse,afterRender,
      canSend:()=>!enabled||!current()?.archived,
      projectSidebar:()=>enabled&&['stage','chat'].includes(state.route)?sidebar():null,
      tabs:(...args)=>enabled?tabs():legacy.tabs(...args), sidebar:()=>enabled?sidebar():legacy.sidebar(),page:()=>enabled?page():legacy.page(),
      context:()=>enabled?context():legacy.context(),welcome:()=>enabled?welcome():legacy.welcome(),preview:()=>enabled?preview():legacy.preview(),overlay:()=>enabled?overlay():legacy.overlay(),
      hasContext:()=>enabled?Boolean(scope()):legacy.hasContext(),compact:()=>enabled?false:legacy.compact(),compactComposer:()=>enabled?'':legacy.compactComposer(),
      branch:()=>enabled?'main':legacy.branch(),label:()=>enabled?(scope()?t('단계에 연결된 대화','Stage-linked conversation'):t('일반 대화','General conversation')):legacy.label(),areaLabel:()=>enabled?t('소프로젝트와 대화','Subprojects and conversations'):legacy.areaLabel(),
      resultCard:()=>enabled?'':legacy.resultCard(),inspect:()=>enabled?M.clone({enabled,view,selected,nodeId,projects,form,formGraph,graphMode,runTab}):legacy.inspect()
    };
  };
})();
