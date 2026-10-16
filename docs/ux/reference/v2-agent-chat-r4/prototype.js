/* Design-review simulation. No Electron bridge, fetch, provider or host filesystem access. */
(() => {
  'use strict';
  const data = window.CHAT_REVIEW;
  const params = new URLSearchParams(location.search);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => window.REVIEW_ICONS[name] || window.REVIEW_ICONS.CircleHelp;
  const t = (ko, en) => state.lang === 'en' ? en : ko;
  const tr = pair => pair[state.lang === 'en' ? 1 : 0];
  const button = (action, label, glyph, cls = 'btn', extra = '') => `<button type="button" class="${cls}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ''}${esc(label)}</button>`;
  const ib = (action, label, glyph, extra = '') => `<button type="button" class="icon-btn" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(glyph)}</button>`;
  const field = (label, html, hint = '') => `<label class="field"><span>${esc(label)}</span>${html}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
  const badge = (label, kind = '') => `<span class="badge ${kind}">${kind ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(label)}</span>`;
  let generation = 0;
  let toastTimer;
  let beforeOverlay = null;
  let modelTurns = 0;
  let notes = {};
  let storageAvailable = true;
  try { notes = JSON.parse(localStorage.getItem('ezterminal:agent-chat-r4:review') || '{}'); } catch { storageAvailable = false; }
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) notes = {};
  const state = {
    lang: params.get('lang') === 'en' ? 'en' : 'ko',
    device: params.get('device') === 'mobile' || (!params.has('device') && innerWidth < 700) ? 'mobile' : 'desktop',
    theme: ['dark','light','high-contrast','matrix'].includes(params.get('theme')) ? params.get('theme') : 'dark',
    skin: params.get('skin') === 'cli' ? 'cli' : 'bubble',
    provider: params.get('provider') === 'claude' ? 'claude' : 'codex',
    scene: 'welcome', route: 'chat', tab: 'skills', catalogMode: 'installed',
    managementProvider: params.get('provider') === 'claude' ? 'claude' : 'codex',
    scope: 'all', search: '', overlay: null, overlayId: '', pickerSearch: '', pickerKind: 'skills',
    offline: false, catalogState: 'ready', installError: '', installType: 'git', installSource: '', installScope: 'project', installProvider: 'codex',
    installPhase: 'edit', installingName: '', activePlugin: 'ezpowers', settingsConflict: false, nextChat: false,
    sessionId: 'draft-1', sessions: {}, counter: 1, serverDraft: null,
    catalogs: {}, packages: {}, servers: {}, simulatedInstalls: 0, reasoningSupported: true, trigger: null
  };
  const session = () => state.sessions[state.sessionId];
  const provider = () => data.providers[session()?.provider || state.provider];
  const skills = (id = session().provider) => state.catalogs[id].filter(skill => skill.enabled!==false && (skill.packageId?state.packages[id][skill.packageId]?.enabled:skill.kind !== 'plugin' || state.packages[id].ezpowers?.enabled));
  const skillScope = (skill,id=session().provider) => skill.kind==='plugin'?(state.packages[id][skill.packageId||'ezpowers']?.scope||'user'):skill.kind;
  const activeScene = () => data.scenes.find(item => item.id === state.scene);
  const unavailableSelected = () => session().selected.some(id => !skills().some(skill => skill.id === id));
  function freshSession(id, providerId = state.provider) {
    return { id, provider: providerId, model: data.providers[providerId].model, effort: 'high', permission: 'standard', draft: '', selected: [], attachments: [], reply: '', messages: [], queue: [], status: 'idle', question: null, answer: '', approval: null, uncertain: false, selection: [0,0], scroll: 0, toolOpen: false, title: '' };
  }
  function seedConversation(s, completed = false) {
    s.title = t('로그인 화면 접근성 검토', 'Login accessibility review');
    s.scroll = Number.MAX_SAFE_INTEGER;
    s.messages = [
      {role:'user',text:t('로그인 화면의 키보드 조작과 오류 안내를 검토해줘.','Review keyboard access and error messages on the login screen.'),skills:['frontend']},
      {role:'assistant',text:completed ? t('로그인 화면 검토를 마쳤습니다.\n\n입력 필드의 이름, 오류 안내와 포커스 이동 순서를 확인했습니다. 비밀번호 표시 버튼에도 접근 가능한 이름을 추가하는 것이 좋겠습니다.','The login screen review is complete.\n\nI checked field labels, error messages and focus order. The password visibility button should also have an accessible name.') : t('먼저 현재 화면과 입력 동작을 확인하겠습니다.','I’ll inspect the screen and its input behaviour first.'), tools:true}
    ];
  }
  function resetScene(id, renderNow = true) {
    generation++;
    state.scene = data.scenes.some(item => item.id === id) ? id : 'welcome';
    state.route = 'chat'; state.tab = 'skills'; state.catalogMode = 'installed'; state.search = ''; state.overlay = null;
    state.offline = false; state.catalogState = 'ready'; state.reasoningSupported=true;state.trigger=null;state.scope='all';state.activePlugin='ezpowers';state.catalogs={};state.packages={};state.servers={};state.simulatedInstalls=0;state.installError = ''; state.installPhase = 'edit'; state.installType = 'git';
    state.installSource = 'https://github.com/example/accessibility-toolkit'; state.installScope = 'project'; state.installProvider = state.provider;
    state.settingsConflict = false; state.nextChat = false; state.managementProvider = state.provider; state.counter = 1;
    state.sessionId = 'draft-1'; state.sessions = { 'draft-1': freshSession('draft-1') }; modelTurns = 0;
    for (const id of ['codex','claude']) {
      state.catalogs[id] = structuredClone(data.skills);
      state.packages[id] = { ezpowers: {installed:true,enabled:true,version:'5.8.0',scope:'user'} };
      state.servers[id] = structuredClone(data.servers);
    }
    const s = session();
    switch (state.scene) {
      case 'loading': state.catalogState = 'loading'; break;
      case 'skills': state.overlay = 'picker'; state.pickerKind = 'skills'; state.pickerSearch = ''; break;
      case 'compose': s.selected = ['frontend']; s.attachments = ['src/LoginPanel.tsx']; s.draft = t('로그인 화면의 키보드 조작과 오류 안내를 검토해줘.','Review keyboard access and error messages on the login screen.'); break;
      case 'streaming': seedConversation(s); s.status = 'working'; break;
      case 'question': seedConversation(s); s.question = 'pending'; s.status = 'blocked'; break;
      case 'approval': seedConversation(s); s.approval = 'pending'; s.status = 'blocked'; break;
      case 'queue': seedConversation(s); s.status = 'working'; s.queue = [{text:t('모바일에서 오류 안내도 같이 확인해줘.','Also check error messages on mobile.'),skills:['frontend'],attachments:[],reply:''}]; s.draft = t('키보드 포커스 표시도 살펴봐줘.','Check keyboard focus indicators too.'); break;
      case 'interrupted': seedConversation(s); s.status = 'interrupted'; s.draft = t('기존 컴포넌트를 유지해줘.','Keep the existing components.'); break;
      case 'history': seedConversation(s,true); s.status = 'completed'; break;
      case 'installed': state.route = 'extensions'; break;
      case 'marketplace': state.route = 'extensions'; state.tab = 'plugins'; state.catalogMode = 'market'; break;
      case 'plugin': state.route = 'plugin'; break;
      case 'install': state.route = 'extensions'; state.overlay = 'install'; break;
      case 'install-failed': state.route = 'extensions'; state.overlay = 'install'; state.installError = t('저장소에 연결하지 못했습니다. 주소와 PC의 연결 상태를 확인하세요. 기존 설치는 유지됩니다.','Could not reach the repository. Check the address and PC connection. Existing installations are unchanged.'); break;
      case 'mcp': state.route = 'extensions'; state.tab = 'mcp'; break;
      case 'mcp-auth': state.route = 'extensions'; state.tab = 'mcp'; state.overlay = 'mcp-auth'; state.overlayId = 'design'; break;
      case 'mcp-failed': state.route='extensions';state.tab='mcp';state.servers[state.provider][1].status='failed';break;
      case 'conflict': state.route = 'extensions'; state.tab = 'mcp'; state.settingsConflict = true; break;
      case 'restart': state.route = 'plugin'; state.nextChat = true; state.packages[state.provider].ezpowers.version = '5.8.1'; break;
      case 'offline': seedConversation(s,true); state.offline = true; s.draft = t('다음에는 비밀번호 재설정 화면을 확인해줘.','Next, review the password reset screen.'); break;
      case 'uncertain': seedConversation(s,true); s.uncertain = true; s.draft = t('모바일에서도 같은 변경을 적용해줘.','Apply the same change on mobile.'); break;
      case 'unavailable': state.catalogState = 'unavailable'; break;
      case 'unsupported': state.reasoningSupported=false;break;
      case 'empty': state.catalogs[state.provider] = []; break;
    }
    journey.reset(state.scene);updateUrl(); if (renderNow) render();
  }
  function updateUrl() {
    const query = new URLSearchParams({scene:state.scene,device:state.device,provider:state.provider,skin:state.skin,theme:state.theme,lang:state.lang});
    try { history.replaceState(null,'',`?${query}`); } catch { /* Some file:// browsers deny history changes. */ }
  }
  function captureView() {
    const input = document.getElementById('draft');
    if (input && session()) { session().draft = input.value; session().selection = [input.selectionStart,input.selectionEnd]; }
    const transcript = document.querySelector('.transcript');
    if (transcript && session()) session().scroll = transcript.scrollTop;
  }
  function render() {
    const focused = document.activeElement?.id;
    document.documentElement.lang = state.lang;
    document.documentElement.dataset.theme = state.theme;
    document.title = `EZTerminal 2.0 · ${t('일반 대화 시안','Chat design review')} r4`;
    document.getElementById('review-toolbar').innerHTML = renderToolbar();
    document.getElementById('app').innerHTML = renderProduct();
    renderOverlay();
    const input = document.getElementById('draft');
    if (input) { input.value = session().draft; input.setSelectionRange(...session().selection); }
    const transcript = document.querySelector('.transcript');
    if (transcript) transcript.scrollTop = session().scroll;
    if (!state.overlay && focused) document.getElementById(focused)?.focus({preventScroll:true});
    document.getElementById('app').inert = Boolean(state.overlay);
    document.getElementById('review-toolbar').inert = Boolean(state.overlay);
    journey.afterRender();
  }
  function renderToolbar() {
    return `<nav class="review-toolbar" aria-label="${t('시안 검토 도구','Design review tools')}">
      <div class="review-label"><span class="revision">r4</span><strong>${t('대화 연결','Connected chat')}</strong><span class="muted">${t('시안','Prototype')}</span></div>
      <select id="scene-select" class="scene-select" aria-label="${t('검토 장면','Review scene')}">${data.scenes.map(item=>`<option value="${item.id}" ${item.id===state.scene?'selected':''}>${esc(tr(item.group))} · ${esc(tr(item.name))}</option>`).join('')}</select>
      <div class="segmented platform-switch" aria-label="${t('기기','Device')}">${button('device-desktop','Windows','Monitor','',`aria-pressed="${state.device==='desktop'}"`)}${button('device-mobile','Android','Smartphone','',`aria-pressed="${state.device==='mobile'}"`)}</div>
      <select id="theme-select" class="theme-select" aria-label="${t('테마','Theme')}">${['dark','light','high-contrast','matrix'].map(value=>`<option value="${value}" ${value===state.theme?'selected':''}>${({'dark':'Dark','light':'Light','high-contrast':'High Contrast','matrix':'Matrix'})[value]}</option>`).join('')}</select>
      <span class="review-note">${t('예시 데이터 · 실제 실행 없음 · 검토 대기','Sample data · No live execution · Awaiting review')}</span>
      ${button('language',state.lang==='ko'?'EN':'KO',null,'btn ghost language-btn')}
      ${button('review',t('검토','Review'),'Pencil','btn')}
    </nav>`;
  }
  function renderProduct() {
    const management = ['extensions','plugin'].includes(state.route);
    return `<div class="product" data-device="${state.device}" data-skin="${state.skin}">
      <header class="product-header">${ib('navigation',t('대화 목록','Conversation list'),'Menu').replace('class="icon-btn"','class="icon-btn mobile-menu"')}
        <div class="wordmark"><span class="brand">ez</span>EZTerminal</div>
        <div class="header-context">${icon('Folder')} EZTerminal <span>/</span> ${state.route==='stage'?journey.areaLabel():t(management?'설정':'대화',management?'Settings':'Conversations')}</div>
        <div class="header-right"><span class="header-hint">${t('내 프로젝트의 AI 작업 공간','Your project’s AI workspace')}</span>${button('new-chat',t('새 대화','New chat'),'Plus')}${ib('extensions',t('확장 기능','Extensions'),'Settings2')}</div>
      </header>
      <nav class="rail" aria-label="${t('주 메뉴','Main navigation')}">
        ${ib('chat',t('프로젝트 대화','Project conversations'),'Folder',management?'':'aria-current="page"').replace('class="icon-btn"',`class="icon-btn ${management?'':'active'}"`)}
        ${ib('about-scope',t('확인할 요청','Attention requests'),'Bell')}
        ${ib('about-scope',t('기존 작업·터미널 도구','Existing task and terminal tools'),'Terminal')}
        <div class="rail-bottom">${ib('extensions',t('확장 기능 설정','Extension settings'),'Settings2').replace('class="icon-btn"',`class="icon-btn ${management?'active':''}"`)}</div>
      </nav>
      ${renderSidebar()}
      <main id="content" class="main" tabindex="-1">${state.route==='stage'?journey.page():state.route==='chat'?renderChat():state.route==='plugin'?renderPlugin():renderManager()}</main>
      <footer class="statusbar"><span class="row">${icon('Monitor')} WORKSTATION</span><span class="${state.offline?'warn':'good'}">${t(state.offline?'오프라인':'연결됨',state.offline?'Offline':'Connected')}</span><span class="right">${t('대화 · 기획 · 실행','Conversation · Planning · Execution')}</span><span>2.0.0</span></footer>
      <nav class="mobile-nav" aria-label="${t('모바일 메뉴','Mobile navigation')}">${button('j-area',t('프로젝트','Projects'),'Folder','','data-id="overview"')}${button('chat',t('대화','Chat'),'MessageSquare',management?'':'active')}${button('j-area',t('작업','Tasks'),'Wrench','','data-id="tasks"')}${button('about-scope',t('터미널','Terminal'),'Terminal','')}${button('navigation',t('더보기','More'),'Ellipsis',management?'active':'')}</nav>
    </div>`;
  }
  function renderSidebar() {
    const projectSidebar=journey.projectSidebar?.();
    if(projectSidebar)return projectSidebar;
    if(state.route==='stage')return journey.sidebar();
    const management = ['extensions','plugin'].includes(state.route);
    return `<aside class="sidebar" aria-label="${t('대화 탐색','Conversation navigation')}">
      <div class="row project-name">${icon('FolderOpen')} <span class="grow">EZTerminal</span>${icon('ChevronDown')}</div>
      <div><div class="sidebar-heading"><h2>${t(management?'AI 설정':'대화',management?'AI settings':'Conversations')}</h2>${ib('new-chat',t('새 대화','New chat'),'Plus')}</div>
      ${management?`<div class="session-list">${button('provider-info',t('제공자 연결','Providers'),'Plug','session-row')}${button('extensions',t('스킬·플러그인·MCP','Skills · Plugins · MCP'),'Layers','session-row active')}${button('chat',t('대화로 돌아가기','Back to conversation'),'ArrowLeft','session-row')}</div>`:`
      <div class="sidebar-caption">${t('현재 작업공간','Current workspace')} · main</div><div class="session-list">
      ${Object.values(state.sessions).map(item=>`<button class="session-row ${item.id===state.sessionId?'active':''}" data-action="session" data-id="${esc(item.id)}">${icon('MessageSquare')}<span><strong>${esc(item.title||t('새 대화','New conversation'))}</strong><small>${data.providers[item.provider].label} · ${esc(item.model)}</small></span></button>`).join('')}
      </div><div class="sidebar-caption">${t('이전 대화','Previous conversations')}</div><button class="session-row" data-action="history">${icon('History')}<span><strong>${t('로그인 화면 접근성 검토','Login accessibility review')}</strong><small>${t('오늘 · 응답 완료','Today · Completed')}</small></span></button>`}</div>
      <div class="sidebar-footer"><strong class="row">${icon('Monitor')} WORKSTATION</strong><small>C:/Projects/EZTerminal</small><small class="row">${icon('GitBranch')} ${journey.branch()}</small></div>
    </aside>`;
  }
  function renderChat() {
    const s = session();
    return `${journey.tabs('chat')}
      <header class="chat-header"><div><h1>${esc(s.title||t('새 대화','New conversation'))}</h1><small>${icon('GitBranch')} ${journey.branch()} <span>·</span> ${provider().label} <span>·</span> ${journey.label()}</small></div>
      <div class="header-controls">${button('skin',state.skin==='bubble'?t('말풍선','Bubbles'):t('CLI 스킨','CLI skin'),state.skin==='bubble'?'MessageSquare':'Terminal','pill',`aria-label="${t('대화 스킨 전환','Switch conversation skin')}"`)}${ib('provider-info',t('대화 정보와 연결','Conversation info and connections'),'Info')}</div></header>
      ${journey.context()}${renderBanner()}
      <div class="conversation-workspace ${journey.hasContext()?'with-context':''}"><div class="chat-area"><div class="transcript" aria-label="${t('대화 내용','Conversation transcript')}" tabindex="0">${s.messages.length?renderMessages():renderWelcome()}${renderInteraction()}${journey.resultCard()}</div>${renderComposer()}</div>${journey.preview()}</div>`;
  }
  function renderBanner() {
    const s = session();
    if (state.offline) return `<div class="notice warning chat-banner">${icon('Unplug')}<div class="grow"><strong>${t('PC 연결이 끊겼습니다','Disconnected from the PC')}</strong><p>${t('마지막 기록과 초안을 보관합니다. 재연결해도 자동 전송하지 않습니다.','History and drafts stay here. Reconnecting will not send anything.')}</p><div class="actions">${button('reconnect',t('다시 연결','Reconnect'),'RefreshCw')}</div></div></div>`;
    if (s.uncertain) return `<div class="notice warning chat-banner">${icon('CircleHelp')}<div class="grow"><strong>${t('메시지 도착 여부를 확인해야 합니다','Message delivery is unconfirmed')}</strong><p>${t('중복 전송하지 않고 PC의 기록을 먼저 확인합니다.','Check the PC’s record before sending again.')}</p><div class="actions">${button('reconcile',t('전송 상태 확인','Check delivery'),'RefreshCw')}</div></div></div>`;
    if (state.catalogState==='unavailable') return `<div class="notice error chat-banner">${icon('TriangleAlert')}<div class="grow"><strong>${t('제공자 연결을 확인하세요','Check the provider connection')}</strong><p>${t('인증 상태를 확인하지 못했습니다. 초안은 유지됩니다.','Authentication could not be verified. Your draft is preserved.')}</p><div class="actions">${button('provider-info',t('연결 설정','Connection settings'),'Settings2')}${button('refresh',t('다시 확인','Recheck'),'RefreshCw')}</div></div></div>`;
    if(!state.reasoningSupported)return `<div class="notice chat-banner">${icon('Info')}<div><strong>${t('이 환경에서는 추론 수준을 바꿀 수 없습니다','Reasoning effort cannot be changed in this environment')}</strong><p>${t('제공자 버전이 이 옵션을 지원하지 않습니다. 기본 설정으로 대화할 수 있습니다.','The provider version does not expose this option. Conversation is available with its default setting.')}</p></div></div>`;
    return '';
  }
  function renderWelcome() {
    if(journey.hasContext())return journey.welcome();
    const loading = state.catalogState==='loading', unavailable=state.catalogState==='unavailable';
    return `<section class="welcome"><div class="welcome-mark">${icon('MessageSquare')}</div><h2>${t('무엇을 함께 할까요?','What shall we work on?')}</h2><p>${t('프로젝트를 살펴보거나, 필요한 스킬과 함께 시작하세요.','Explore the project, or start with the right skill.')}</p>
      <div class="ready-row"><span class="row ${loading||unavailable?'':'ready'}">${icon(loading?'LoaderCircle':unavailable?'TriangleAlert':'CheckCheck')}${unavailable?t('연결 확인 필요','Connection needs attention'):t(loading?'기능 확인 중':'대화 준비됨',loading?'Preparing capabilities':'Ready to chat')}</span><button data-action="skills">${t('스킬','Skills')} ${loading?'…':skills().length}</button><button data-action="mcp">MCP ${t('연결','connected')} ${state.servers[session().provider].filter(server=>server.status==='connected').length}</button>${button('refresh',t('새로고침','Refresh'),'RefreshCw','pill')}</div>
      ${loading?`<div class="loading-items" aria-label="${t('기능 목록 불러오는 중','Loading capabilities')}"><span class="skeleton"></span><span class="skeleton"></span></div><p class="muted">${t('확인하는 동안 메시지를 작성할 수 있습니다.','You can write while the catalog loads.')}</p>`:''}
      <div class="quick-prompts">${button('prompt-explore',t('프로젝트 살펴보기','Explore the project'),'Folder')}${button('prompt-ui',t('UI 검토하기','Review the UI'),'Layers')}${button('prompt-debug',t('문제 진단하기','Diagnose an issue'),'Wrench')}</div>
      <div class="quick-skills"><div class="quick-skills-title"><span>${t('이 대화에서 사용할 수 있는 스킬','Skills available in this conversation')}</span>${button('skills',t('모두 보기','View all'),'ChevronRight','pill')}</div>
      ${skills().length?`<div class="actions">${skills().slice(0,3).map(skill=>button('select-skill',skill.name,skill.icon,'pill',`data-id="${skill.id}"`)).join('')}</div>`:`<p class="muted">${t('설치된 스킬이 없습니다. 일반 메시지는 바로 보낼 수 있습니다.','No skills installed. You can still send a regular message.')}</p><div class="actions">${button('market',t('스킬 찾아보기','Browse skills'),'Plus','btn')}</div>`}</div></section>`;
  }
  function renderMessages() {
    return session().messages.map((message,index)=>`<article class="message ${message.role}" data-message-id="message-${index}">
      <div class="message-author">${icon(message.role==='user'?'MessageSquare':'Sparkles')}<span>${message.role==='user'?t('나','You'):provider().label}</span><time datetime="2026-10-13T10:24:00+09:00">10:${String(24+index).padStart(2,'0')}</time></div>
      ${(message.skills||[]).length?`<div class="actions" style="margin-bottom:8px">${message.skills.map(id=>`<span class="badge">${esc(data.skills.find(skill=>skill.id===id)?.name||id)}</span>`).join('')}</div>`:''}
      <div class="message-body">${esc(message.text)}</div>
      ${message.tools?`<details class="tool-group" ${session().toolOpen?'open':''}><summary>${t('확인한 항목 2개','2 items inspected')} <span class="muted">· src/LoginPanel.tsx</span></summary><div class="tool-details"><div class="tool-line">${icon('Check')}<span>${t('프로젝트 지침 읽기','Read project instructions')}</span><code>AGENTS.md</code></div><div class="tool-line">${icon('Check')}<span>${t('화면 구성 확인','Inspect screen structure')}</span><code>src/LoginPanel.tsx</code></div><p>${t('입력 필드의 label과 키보드 이동 순서를 확인했습니다.','Checked field labels and keyboard navigation order.')}</p></div></details>`:''}
      <div class="message-actions">${button('copy-message',t('복사','Copy'),'Copy','',`data-index="${index}"`)}${button('reply',t('답장','Reply'),'MessageSquare','',`data-index="${index}"`)}${message.role==='user'?button('reuse',t('입력에 가져오기','Use as draft'),'Pencil','',`data-index="${index}"`):''}</div></article>`).join('');
  }
  function renderInteraction() {
    const s = session();
    if (s.question==='pending') return `<section class="interaction-card" aria-label="${t('에이전트 질문','Agent question')}"><div class="row">${icon('CircleHelp')}<h2>${t('어느 범위까지 확인할까요?','How much should I review?')}</h2></div><p>${t('우선 검토할 화면을 선택해 주세요.','Choose the screens to review first.')}</p><fieldset style="border:0;padding:0;margin:0"><legend class="sr-only">${t('검토 범위','Review scope')}</legend><div class="options">${[[t('로그인 화면부터','Start with the login screen'),'login'],[t('로그인·회원가입 함께','Login and sign-up together'),'both']].map(([label,value])=>`<label class="choice"><input type="radio" name="answer" value="${value}" ${s.answer===value?'checked':''}>${esc(label)}</label>`).join('')}</div></fieldset><input id="free-answer" class="free-answer" aria-label="${t('직접 답변','Your own answer')}" placeholder="${t('또는 직접 입력하세요','Or type your own answer')}" value="${esc(!['login','both'].includes(s.answer)?s.answer:'')}"><div class="actions">${button('answer',t('답변 보내기','Send answer'),'ArrowUp','btn primary',s.answer?'':'disabled')}</div></section>`;
    if (s.approval==='pending') return `<section class="interaction-card" aria-label="${t('변경 승인 요청','Change approval request')}"><div class="row">${icon('ShieldCheck')}<h2>${t('파일 변경을 허용할까요?','Allow this file change?')}</h2></div><p>${t('비밀번호 표시 버튼에 접근 가능한 이름을 추가합니다.','Add an accessible name to the password visibility button.')}</p><div class="selected-summary"><code>src/LoginPanel.tsx</code><p>${t('현재 프로젝트 · 파일 1개 수정','Current project · Modify 1 file')}</p><code>+ aria-label="${t('비밀번호 표시','Show password')}"</code></div><div class="actions" style="margin-top:16px">${button('deny',t('거절','Deny'),null)}${button('allow',t('이번만 허용','Allow once'),'Check','btn primary')}</div></section>`;
    if (s.status==='working') return `<div class="activity" role="status"><span class="spin">${icon('LoaderCircle')}</span>${t('입력 동작과 오류 안내를 확인하고 있습니다…','Checking input behaviour and error messages…')}</div>`;
    if (s.status==='interrupted') return `<div class="notice"><div>${icon('Square')}</div><div class="grow"><strong>${t('응답을 중단했습니다','Response interrupted')}</strong><p>${t('지금까지의 내용과 작성 중인 메시지는 그대로 있습니다.','The partial response and your draft are preserved.')}</p><div class="actions">${button('continue',t('대화 이어가기','Continue conversation'),'Play')}</div></div></div>`;
    return '';
  }
  function canSend() { const s=session(); return journey.canSend?.()!==false && Boolean(s.draft.trim()||s.attachments.length) && !state.offline && !s.uncertain && state.catalogState!=='unavailable' && !unavailableSelected() && s.status!=='blocked'; }
  function renderComposer() {
    if(journey.compact())return journey.compactComposer();
    const s = session(), busy = s.status==='working';
    const preset = {plan:t('읽기 전용','Read only'),standard:t('표준 권한','Standard'),full:t('전체 권한','Full access')};
    return `<section class="composer-region" aria-label="${t('메시지 작성','Compose message')}">
      ${s.queue.length?`<div class="queue"><div class="queue-title">${t('응답 뒤에 전송','Send after this response')} · ${s.queue.length}</div>${s.queue.map((item,index)=>`<div class="queued-item"><span>${esc(item.text)}${item.skills.length?' · '+t('스킬 포함','with skills'):''}</span>${ib('queue-edit',t('대기 메시지 편집','Edit queued message'),'Pencil',`data-index="${index}"`)}${ib('queue-remove',t('대기 메시지 제거','Remove queued message'),'X',`data-index="${index}"`)}</div>`).join('')}<div class="queue-title">${button('interrupt-send',t('중단 후 첫 대기 메시지 전송','Interrupt and send first queued message'),'ArrowUp','pill')}</div></div>`:''}
      ${unavailableSelected()?`<div class="notice warning" style="margin-bottom:8px">${t('선택한 스킬을 현재 사용할 수 없습니다. 제거하거나 설치 상태를 확인하세요.','A selected skill is no longer available. Remove it or check its installation.')}</div>`:''}
      <form id="chat-form" class="composer-box">
        ${s.reply?`<div class="reply-context"><span>${t('답장','Reply')} · ${esc(s.reply)}</span>${ib('remove-reply',t('답장 취소','Remove reply'),'X')}</div>`:''}
        <div class="composer-context">${s.selected.map(id=>{const skill=data.skills.find(item=>item.id===id)||state.catalogs[s.provider].find(item=>item.id===id);return `<span class="chip skill">${icon('Sparkles')}<span>${esc(skill?.name||id)}</span>${ib('remove-skill',`${skill?.name||id} ${t('제거','remove')}`,'X',`data-id="${esc(id)}"`)}</span>`;}).join('')}${s.attachments.map((name,index)=>`<span class="chip">${icon('FileText')}<span>${esc(name)}</span>${ib('remove-attachment',`${name} ${t('제거','remove')}`,'X',`data-index="${index}"`)}</span>`).join('')}</div>
        <label class="sr-only" for="draft">${t('메시지','Message')}</label><textarea id="draft" rows="2" placeholder="${t('메시지를 입력하세요. / 스킬·명령, @ 파일','Write a message. / skills & commands, @ files')}" ${s.uncertain?'readonly':''}></textarea>
        <div class="composer-bottom">${ib('attachment',t('첨부 추가','Add attachment'),'Paperclip')}${ib('skills',t('스킬과 명령 찾기','Find skills and commands'),'Sparkles')}${ib('files',t('프로젝트 파일 참조','Reference project files'),'FileCode2')}<span class="composer-divider"></span>
          <div class="composer-options">${button('model',s.model,'ChevronDown','pill',`aria-label="${t('모델과 추론 설정','Model and reasoning settings')}"`)}${button('model',state.reasoningSupported?s.effort:t('기본 추론','Default effort'),null,'pill',`aria-label="${t('추론 수준','Reasoning effort')}" ${state.reasoningSupported?'':'disabled'}`)}${button('permission',preset[s.permission],'ShieldCheck','pill')}</div>
          ${busy?ib('stop',t('현재 응답 중단','Stop current response'),'Square'):''}<button id="send" type="submit" class="btn primary send" aria-label="${busy?t('대기열에 추가','Add to queue'):t('메시지 전송','Send message')}" ${canSend()?'':'disabled'}>${icon(busy?'Plus':'ArrowUp')}</button>
        </div>
      </form><div class="composer-foot"><span>${state.device==='mobile'?t('줄바꿈은 Enter · 전송은 버튼','Enter for a new line · Tap to send'):t('Enter 전송 · Shift+Enter 줄바꿈','Enter to send · Shift+Enter for a new line')}</span>${button('provider',provider().label,'ChevronDown','')}</div>
    </section>`;
  }
  function managerControls() {
    return `<div class="scope-bar"><span>${icon('Monitor')} WORKSTATION ${badge(t(state.offline?'오프라인':'연결됨',state.offline?'Offline':'Connected'),state.offline?'warn':'good')}</span><label class="row"><span class="sr-only">${t('관리할 제공자','Provider to manage')}</span><select id="management-provider">${Object.keys(data.providers).map(id=>`<option value="${id}" ${state.managementProvider===id?'selected':''}>${data.providers[id].label}</option>`).join('')}</select></label><label class="row"><span class="sr-only">${t('적용 범위 필터','Scope filter')}</span><select id="scope-filter">${[['all',t('모든 범위','All scopes')],['user',t('사용자 전체','User-wide')],['project',t('이 프로젝트','This project')]].map(([id,label])=>`<option value="${id}" ${state.scope===id?'selected':''}>${label}</option>`).join('')}</select></label></div>`;
  }
  function renderManager() {
    return `<div class="manager"><div class="manager-inner"><div class="manager-intro"><div><div class="eyebrow">${t('설정 / AI','Settings / AI')}</div><h1>${t('스킬·플러그인·MCP','Skills, plugins & MCP')}</h1><p>${t('익숙한 도구를, 지금 대화에서도. PC의 기존 설정을 함께 사용합니다.','Your familiar tools, in this conversation. Shared with your PC’s existing setup.')}</p></div><div class="actions">${button('chat',t('대화로','Back to chat'),'ArrowLeft')}${button('install-source',t('직접 추가','Add source'),'Plus')}</div></div>
      ${managerControls()}
      ${state.offline?`<div class="notice warning">${t('PC 연결이 필요합니다. 마지막 목록을 표시하며 변경은 전송하지 않습니다.','PC connection required. Showing the last catalog; changes cannot be sent.')}</div>`:''}
      ${state.settingsConflict?`<div class="notice warning" style="margin-bottom:16px">${icon('TriangleAlert')}<div><strong>${t('다른 앱에서 설정이 변경되었습니다','Settings changed in another app')}</strong><p>${t('작성한 값을 보관했습니다. 최신 설정을 확인한 뒤 다시 적용하세요.','Your draft is preserved. Review the latest settings before applying.')}</p><div class="actions">${button('resolve-conflict',t('변경 내용 확인','Review changes'),'FileText')}</div></div></div>`:''}
      <div class="manager-tabs" aria-label="${t('확장 종류','Extension categories')}">${[['skills',t('스킬','Skills')],['plugins',t('플러그인','Plugins')],['mcp','MCP']].map(([id,label])=>button('manager-tab',label,null,'',`data-id="${id}" aria-pressed="${state.tab===id}"`)).join('')}</div>
      ${state.tab==='mcp'?renderServers():renderCatalog()}
    </div></div>`;
  }
  function renderCatalog() {
    const browse = state.catalogMode==='market';
    const list = browse?data.market:state.tab==='plugins'?data.market.filter(item=>state.packages[state.managementProvider][item.id]?.installed):state.catalogs[state.managementProvider].filter(skill=>skill.kind!=='plugin'||state.packages[state.managementProvider][skill.packageId||'ezpowers']?.installed);
    const filtered = list.filter(item=>(state.scope==='all'||(state.packages[state.managementProvider][item.id]?.scope || skillScope(item,state.managementProvider)||'user')===state.scope) && `${item.name} ${tr(item.description)} ${item.source}`.toLowerCase().includes(state.search.toLowerCase()));
    return `<div class="list-toolbar"><div class="search-field">${icon('Search')}<input id="extension-search" aria-label="${t('확장 검색','Search extensions')}" placeholder="${t('이름·설명·출처로 검색','Search name, description or source')}" value="${esc(state.search)}"></div><div class="segmented">${button('catalog-installed',t('설치됨','Installed'),null,'',`aria-pressed="${!browse}"`)}${button('catalog-market',t('마켓 탐색','Browse'),null,'',`aria-pressed="${browse}"`)}</div></div>
      <p class="section-caption">${browse?t('등록된 제공자 마켓 · 시안용 목록','Registered provider marketplaces · Sample catalog'):t('선택한 PC와 제공자의 확장','Extensions on the selected PC and provider')} · ${filtered.length}</p>
      <div class="extension-list">${filtered.length?filtered.map(item=>{
        const isPlugin = browse || state.tab==='plugins';
        const installed = isPlugin?state.packages[state.managementProvider][item.id]?.installed:true;
        const disabled = isPlugin ? installed && !state.packages[state.managementProvider][item.id]?.enabled : item.enabled===false||(item.kind==='plugin'&&!state.packages[state.managementProvider][item.packageId||'ezpowers']?.enabled);
        return `<article class="extension-row"><div class="extension-icon">${icon(item.icon)}</div><div class="extension-copy"><h3>${esc(item.name)}</h3><p>${esc(tr(item.description))}</p><div class="extension-meta"><span>${esc(item.source)}</span><span>${(state.packages[state.managementProvider][item.id]?.scope || skillScope(item,state.managementProvider))==='project'?t('이 프로젝트','This project'):t('사용자 전체','User-wide')}</span>${item.kind==='plugin'?`<span>${t('플러그인에서 제공','Provided by a plugin')}</span>`:''}</div></div><div class="actions">${installed?badge(t(disabled?'사용 안 함':'설치됨',disabled?'Disabled':'Installed'),disabled?'':'good'):''}${isPlugin?button(installed?'plugin-detail':'install-market',t(installed?'상세':'설치',installed?'Details':'Install'),installed?'ChevronRight':'Plus','btn',`data-id="${item.id}" ${state.offline?'disabled':''}`):button('skill-detail',t('상세','Details'),'ChevronRight','icon-btn',`data-id="${item.id}" aria-label="${esc(item.name)} ${t('상세','details')}"`)}</div></article>`;
      }).join(''):`<div class="empty-list">${icon('Search')}<h3>${t('표시할 항목이 없습니다','No matching extensions')}</h3><p>${t('검색어와 범위를 바꾸거나 마켓에서 찾아보세요.','Change the search or scope, or browse the marketplaces.')}</p>${button('reset-filter',t('검색·필터 초기화','Reset search and filters'),'RefreshCw')}</div>`}</div>
      <p class="section-caption">${t('설치·설정은 선택한 PC에 반영되며 같은 제공자를 사용하는 다른 앱과 공유됩니다.','Installation and settings apply to the selected PC and are shared with other apps using the same provider.')}</p>`;
  }
  function renderServers() {
    return `<div class="list-toolbar"><p class="muted" style="font-size:12px">${t('서버별 연결 상태와 사용 가능한 도구','Connection status and available tools')}</p>${button('add-mcp',t('서버 추가','Add server'),'Plus','btn',state.offline?'disabled':'')}</div><div class="extension-list">${state.servers[state.managementProvider].filter(server=>state.scope==='all'||(server.scope||(server.id==='project'?'project':'user'))===state.scope).map(server=>`<article class="extension-row"><div class="extension-icon">${icon('Plug')}</div><div class="extension-copy"><h3>${esc(server.name)}</h3><p>${esc(tr(server.description))}</p><div class="extension-meta"><span>${server.transport}</span><span>${server.status==='connected'?`${t('도구','Tools')} ${server.tools}`:server.status==='failed'?t('PC의 서버 실행 상태를 확인하세요','Check the server on the PC'):server.status==='disabled'?t('사용 설정 후 연결','Enable to connect'):t('인증 후 도구 확인','Tools available after authentication')}</span><span>${(server.scope||(server.id==='project'?'project':'user'))==='project'?t('이 프로젝트','This project'):t('사용자 전체','User-wide')}</span></div></div><div class="actions">${badge(server.status==='connected'?t('연결됨','Connected'):server.status==='disabled'?t('사용 안 함','Disabled'):server.status==='failed'?t('연결 실패','Connection failed'):t('인증 필요','Sign-in needed'),server.status==='connected'?'good':server.status==='disabled'?'':'warn')}${button(server.status==='failed'?'reconnect-mcp':server.status==='needs-auth'?'mcp-auth':'edit-mcp',server.status==='failed'?t('다시 연결','Retry connection'):server.status==='needs-auth'?t('연결','Connect'):t('설정','Settings'),server.status==='needs-auth'?'Link':'Settings2','btn',`data-id="${server.id}" ${state.offline?'disabled':''}`)}</div></article>`).join('')}</div><div class="notice" style="margin-top:20px">${icon('Info')}<p>${t('MCP 설정은 PC의 Codex·Claude 환경과 공유합니다. 인증 정보는 목록과 대화에 표시하지 않습니다.','MCP settings are shared with Codex and Claude on the PC. Credentials are not shown in the catalog or conversation.')}</p></div>`;
  }
  function renderPlugin() {
    const entry=data.market.find(item=>item.id===state.activePlugin)||data.market[0];
    const pkg=state.packages[state.managementProvider][entry.id]||{installed:false,enabled:false,version:'1.0.0',scope:'project'};
    return `<div class="manager"><div class="manager-inner">${button('extensions',t('확장 기능으로','Back to extensions'),'ArrowLeft','back-link')}${managerControls()}
      <div class="detail-hero"><div class="extension-icon">${icon(entry.icon)}</div><div class="grow"><div class="eyebrow">${esc(entry.source)} / PLUGIN</div><h1>${esc(entry.name)}</h1><p class="muted">${esc(tr(entry.description))}</p><div class="actions" style="margin-top:10px">${badge(`v${pkg.version}`)}${badge(t(pkg.installed?'설치됨':'설치 안 됨',pkg.installed?'Installed':'Not installed'),pkg.installed?'good':'')}${pkg.installed?badge(t(pkg.enabled?'사용 중':'사용 안 함',pkg.enabled?'Enabled':'Disabled')):''}</div></div></div>
      ${state.nextChat?`<div class="notice success" style="margin-bottom:20px">${icon('Check')}<div><strong>${t('업데이트 완료 · 새 대화부터 적용','Updated · Applies to new conversations')}</strong><p>${t('진행 중인 대화는 기존 버전을 유지합니다. 초안을 보존하고 새 대화를 열 수 있습니다.','Active conversations keep their current version. You can open a new conversation without losing the draft.')}</p><div class="actions">${button('new-chat',t('새 대화 열기','Open a new conversation'),'Plus')}</div></div>`:''}
      <div class="detail-columns"><section class="detail-box"><h2>${t('포함된 기능','Included capabilities')}</h2>${(entry.id==='ezpowers'?data.skills.filter(skill=>skill.kind==='plugin'):[{name:entry.id==='repo-notes'?'repository-notes':'accessibility-review',description:entry.description,icon:entry.icon}]).map(skill=>`<div class="tool-line">${icon(skill.icon)}<div><strong>${esc(skill.name)}</strong><p>${esc(tr(skill.description))}</p></div></div>`).join('')}<hr class="divider"><p>${t('플러그인에 포함된 스킬은 개별 파일을 지우지 않고 플러그인 단위로 관리합니다.','Skills bundled with a plugin are managed with their parent package.')}</p></section>
      <aside class="detail-box"><h2>${t('설치 정보','Installation')}</h2><dl><dt>${t('실행 PC','Execution host')}</dt><dd>WORKSTATION</dd><dt>${t('제공자','Provider')}</dt><dd>${data.providers[state.managementProvider].label}</dd><dt>${t('적용 범위','Scope')}</dt><dd>${pkg.scope==='project'?t('이 프로젝트','This project'):t('사용자 전체','User-wide')}</dd><dt>${t('설정 공유','Shared configuration')}</dt><dd>${t('같은 PC의 제공자 환경','Provider environment on this PC')}</dd></dl>
      ${pkg.installed?`${button('update-plugin',t('업데이트 확인','Check for updates'),'RefreshCw','btn',state.offline?'disabled':'')}${button('toggle-plugin',t(pkg.enabled?'사용 안 함으로 변경':'사용 설정',pkg.enabled?'Disable':'Enable'),'Package','btn',state.offline?'disabled':'')}${button('remove-plugin',t('플러그인 삭제','Remove plugin'),'Trash2','btn danger',state.offline?'disabled':'')}`:button('install-market',t('설치','Install'),'Plus','btn primary',`data-id="${entry.id}" ${state.offline?'disabled':''}`)}</aside></div>
    </div></div>`;
  }
  function modal(title, body, footer = '', wide = false) {
    return `<section class="dialog ${wide?'wide':''} ${state.overlay==='picker'?'picker':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2>${ib('close',t('닫기','Close'),'X')}</header><div class="dialog-body">${body}</div>${footer?`<footer class="dialog-footer">${footer}</footer>`:''}</section>`;
  }
  const cancel = () => button('close',t('취소','Cancel'),null,'btn','id="dialog-cancel"');
  function renderOverlay() {
    const root=document.getElementById('overlay-root');
    if (!state.overlay) { root.innerHTML=''; return; }
    let html=''; const s=session();
    switch (state.overlay) {
      case 'picker': html=renderPicker(); break;
      case 'model': html=modal(t('모델과 추론','Model and reasoning'),`<p>${t('지금 선택한 설정이 다음 메시지부터 적용됩니다.','These settings apply to the next message.')}</p>${field(t('모델','Model'),`<select id="model-choice">${provider().models.map(model=>`<option ${model===s.model?'selected':''}>${esc(model)}</option>`).join('')}</select>`)}${field(t('추론 수준','Reasoning effort'),`<select id="effort-choice" ${state.reasoningSupported?'':'disabled'}>${provider().efforts.map(effort=>`<option ${effort===s.effort?'selected':''}>${effort}</option>`).join('')}</select>`)}<p class="inline-warning">${t('모델 이름은 시안용 예시입니다. 제품에서는 현재 제공자가 반환하는 목록을 사용합니다.','Model names are examples. The product will use the current provider’s reported catalog.')}</p>`,cancel()+button('save-model',t('적용','Apply'),'Check','btn primary')); break;
      case 'permission': html=modal(t('대화 권한','Conversation permissions'),`<p>${t('이 대화가 수행할 수 있는 작업 범위입니다.','Choose the actions this conversation may perform.')}</p><div class="options" style="margin-top:16px">${[['plan',t('읽기 전용','Read only'),t('파일을 읽고 계획합니다. 변경 작업은 허용하지 않습니다.','Read files and plan; no write actions.')],['standard',t('표준 권한','Standard'),t('현재 정책에 따라 변경·외부 작업을 승인합니다.','Approve changes and external actions according to the current policy.')],['full',t('전체 권한','Full access'),t('사용 중인 제공자가 허용하는 확장된 작업 범위입니다.','Extended action scope allowed by the provider.')]].map(([id,label,hint])=>`<label class="choice"><input name="permission" type="radio" value="${id}" ${s.permission===id?'checked':''}><span><strong>${label}</strong><small style="display:block;margin-top:3px">${hint}</small></span></label>`).join('')}</div>`,cancel()+button('save-permission',t('적용','Apply'),'Check','btn primary')); break;
      case 'provider': html=modal(t('대화 제공자','Conversation provider'),`<p>${s.messages.length?t('진행한 대화의 제공자는 유지합니다. 다른 제공자를 선택하면 새 대화를 엽니다.','Existing conversations keep their provider. Selecting another opens a new conversation.'):t('선택한 제공자의 스킬·모델·연결 상태를 불러옵니다.','Load skills, models and connections for the selected provider.')}</p><div class="stack" style="margin-top:16px">${Object.entries(data.providers).map(([id,p])=>button('choose-provider',p.label,'MessageSquare','btn',`data-id="${id}" aria-pressed="${s.provider===id}"`)).join('')}</div>`); break;
      case 'provider-info': html=modal(t('대화 준비 상태','Conversation readiness'),`<div class="row between"><h3>${provider().label}</h3>${badge(t(state.catalogState==='unavailable'?'확인 필요':'준비됨',state.catalogState==='unavailable'?'Needs attention':'Ready'),state.catalogState==='unavailable'?'warn':'good')}</div><div class="selected-summary"><p>${t('실행 위치','Workspace')} <code>C:/Projects/EZTerminal</code></p><p>${t('제공자 설정','Provider settings')} · ${t('PC의 기존 환경 공유','Shared PC environment')}</p><p>${t('스킬','Skills')} ${skills().length} · MCP ${state.servers[s.provider].length}</p></div><p style="margin-top:14px">${t('인증은 선택한 PC의 제공자 계정에서 확인합니다. 첫 메시지를 보내야 목록을 볼 수 있는 구조를 없앱니다.','Authentication belongs to the selected PC. Capability discovery does not require a first message.')}</p>`,button('mcp',t('MCP 관리','Manage MCP'),'Plug')+button('refresh',t('다시 확인','Recheck'),'RefreshCw','btn primary')); break;
      case 'attachment': html=modal(t('첨부와 파일 참조','Attachments and references'),`<p>${t('이 체험은 준비된 예시 파일만 추가합니다. 실제 파일은 읽거나 업로드하지 않습니다.','This review adds sample files only. No real files are read or uploaded.')}</p><div class="stack" style="margin-top:16px">${button('add-sample-image',t('예시 이미지 첨부 · login-screen.png','Attach sample image · login-screen.png'),'Paperclip')}${button('files',t('PC 프로젝트 파일 선택','Choose a PC project file'),'Folder')}</div>`); break;
      case 'skill-detail': {
        const skill=state.catalogs[state.managementProvider].find(item=>item.id===state.overlayId)||data.skills[0];
        const owner=skill.packageId||'ezpowers', ownerName=data.market.find(item=>item.id===owner)?.name||skill.source;
        html=modal(skill.name,`<p>${esc(tr(skill.description))}</p><div class="selected-summary"><p>${t('출처','Source')} · ${esc(skill.source)}</p><p>${t('호출','Invoke')} <code>${esc(data.providers[state.managementProvider].prefix+skill.token)}</code></p><p>${t('적용 범위','Scope')} · ${skillScope(skill,state.managementProvider)==='project'?t('이 프로젝트','This project'):t('사용자 전체','User-wide')}</p></div>${skill.kind==='plugin'?`<p style="margin-top:14px">${esc(ownerName)+' · '+t('플러그인에 포함된 스킬입니다. 설치·삭제는 플러그인에서 관리합니다.','This skill belongs to the plugin. Manage installation and removal through its package.')}</p>`:''}`,(skill.kind!=='plugin'?button('toggle-skill-install',skill.enabled===false?t('사용 설정','Enable'):t('사용 안 함','Disable'),'Package','btn',`data-id="${skill.id}" ${state.offline?'disabled':''}`):'')+button(skill.kind==='plugin'?'plugin-detail':'remove-skill-install',skill.kind==='plugin'?t('플러그인 관리','Manage plugin'):t('설치된 스킬 삭제','Remove installed skill'),skill.kind==='plugin'?'Package':'Trash2','btn',`data-id="${skill.kind==='plugin'?owner:skill.id}" ${state.offline?'disabled':''}`)+button('use-managed-skill',t('대화에서 사용','Use in conversation'),'ArrowRight','btn primary',`data-id="${skill.id}" ${state.managementProvider!==s.provider||state.offline||!skills(state.managementProvider).some(item=>item.id===skill.id)?'disabled':''}`)); break;
      }
      case 'install': html=renderInstall(); break;
      case 'remove-plugin': html=modal(t('플러그인을 삭제할까요?','Remove this plugin?'),`<p>${t('선택한 PC와 제공자에서 이 플러그인과 포함된 스킬이 제거됩니다. 같은 설정을 공유하는 다른 앱에도 반영됩니다.','The plugin and its bundled skills will be removed for the selected PC and provider, including other apps sharing this setup.')}</p><div class="selected-summary"><strong>${esc(data.market.find(item=>item.id===state.activePlugin)?.name||state.activePlugin)}</strong><p>WORKSTATION · ${data.providers[state.managementProvider].label}</p><p>${t('기존 대화 기록은 유지됩니다.','Existing conversation history is preserved.')}</p></div>`,cancel()+button('confirm-remove-plugin',t('삭제','Remove'),'Trash2','btn danger')); break;
      case 'remove-skill-install': html=modal(t('설치된 스킬을 삭제할까요?','Remove the installed skill?'),`<p>${t('선택한 PC의 해당 스킬 사본을 제거합니다. 대화 기록은 유지합니다.','Remove this skill’s copy on the selected PC. Conversation history is preserved.')}</p><div class="selected-summary">${esc(state.overlayId)} · ${data.providers[state.managementProvider].label}</div>`,cancel()+button('confirm-remove-skill',t('삭제','Remove'),'Trash2','btn danger')); break;
      case 'mcp-edit': html=renderMcpForm(); break;
      case 'remove-mcp-confirm': html=modal(t('MCP 서버를 삭제할까요?','Remove this MCP server?'),`<p>${esc(state.serverDraft.name)} · WORKSTATION · ${data.providers[state.managementProvider].label}</p><p>${t('PC의 공유 설정에서 제거합니다. 대화 기록은 유지합니다.','Remove it from the PC’s shared settings. Conversation history is preserved.')}</p>`,cancel()+button('confirm-remove-mcp',t('삭제','Remove'),'Trash2','btn danger'));break;
      case 'mcp-auth': html=modal(t('PC에서 연결을 완료하세요','Complete the connection on the PC'),`<div class="row">${icon('Monitor')}<h3>WORKSTATION</h3></div><p style="margin-top:14px">${t('Design library는 PC의 브라우저에서 로그인이 필요합니다. 같은 PC에서 인증을 마친 뒤 연결 상태를 다시 확인하세요.','Design library needs browser sign-in on the PC. Complete authentication there, then recheck the connection.')}</p><div class="selected-summary"><p>${t('대상','Target')} · Design library</p><p>${t('제공자','Provider')} · ${data.providers[state.managementProvider].label}</p><p>${t('휴대전화에 인증 정보를 복사하지 않습니다.','Credentials are not copied to your phone.')}</p></div>`,button('auth-instructions',t('PC 인증 안내','PC sign-in steps'),'ExternalLink')+button('check-auth',t('인증 후 다시 확인','Recheck after sign-in'),'RefreshCw','btn primary')); break;
      case 'conflict': html=modal(t('MCP 설정 변경 확인','Review MCP settings change'),`<p>${t('PC에서 서버 주소가 바뀌었습니다. 작성 중인 변경은 아직 적용되지 않았습니다.','The server address changed on the PC. Your draft has not been applied.')}</p><div class="selected-summary"><p>${t('현재 PC 설정','Current PC setting')}</p><code>https://docs.example.com/v2/mcp</code><p>${t('작성 중인 설정','Your draft')}</p><code>https://docs.example.com/mcp</code></div><p style="margin-top:12px">${t('최신 설정을 불러와 내용을 다시 확인합니다. 자동으로 덮어쓰지 않습니다.','Load the latest settings for review. Nothing is overwritten automatically.')}</p>`,cancel()+button('reload-settings',t('최신 설정 불러오기','Load latest settings'),'RefreshCw','btn primary')); break;
      case 'copy': html=modal(t('메시지 복사','Copy message'),field(t('복사할 내용','Text to copy'),`<textarea id="copy-text" readonly>${esc(s.messages[Number(state.overlayId)]?.text||'')}</textarea>`,t('텍스트를 선택해 복사하세요.','Select the text and copy it.')),button('close',t('완료','Done'),'Check')); break;
      case 'review': html=renderReview(); break;
      case 'navigation': html=modal(t('대화와 설정','Conversations and settings'),`<div class="stack">${button('new-chat',t('새 대화','New conversation'),'Plus')}${Object.values(state.sessions).map(item=>button('session',item.title||t('새 대화','New conversation'),'MessageSquare','btn',`data-id="${item.id}"`)).join('')}${button('history',t('이전 대화 기록','Previous conversations'),'History')}${button('extensions',t('스킬·플러그인·MCP','Skills · Plugins · MCP'),'Layers')}</div>`); break;
      default: html=journey.overlay();break;
      case 'about-scope': html=modal(t('이번 시안의 범위','Scope of this prototype'),`<p>${t('일반 대화와 확장 관리 흐름을 검토하는 시안입니다. 기획·작업·실제 터미널은 기존 2.0 동작을 유지합니다.','This prototype covers general conversations and extension management. Planning, tasks and the real terminal keep their existing 2.0 behaviour.')}</p>`,button('close',t('돌아가기','Back'),'ArrowLeft')); break;
    }
    root.innerHTML=`<div class="overlay-shade" data-mobile="${state.device==='mobile'}" data-kind="${state.overlay}">${html}</div>`;
  }
  function renderPicker() {
    const files=state.pickerKind==='files';
    const q=state.pickerSearch.toLowerCase();
    const fileNames=['src/LoginPanel.tsx','src/renderer/StructuredAgentSession.tsx','docs/ux/frontend-design.md','AGENTS.md'];
    const matched=skills().filter(skill=>`${skill.name} ${tr(skill.description)} ${skill.source}`.toLowerCase().includes(q));
    const commands=[['model',t('모델과 추론 선택','Choose model and reasoning'),'model'],['permissions',t('대화 권한 설정','Set conversation permissions'),'permission'],['skills',t('스킬·플러그인 관리','Manage skills and plugins'),'extensions'],['mcp',t('MCP 연결 확인','Inspect MCP connections'),'mcp'],['new',t('새 대화 열기','Open a new conversation'),'new-chat']].filter(([name,label])=>`${name} ${label}`.toLowerCase().includes(q));
    const results=files?fileNames.filter(name=>name.toLowerCase().includes(q)).map(name=>`<button class="picker-item" data-action="add-file" data-name="${name}">${icon('FileCode2')}<span><strong>${name}</strong><small>${t('WORKSTATION · 현재 프로젝트','WORKSTATION · Current project')}</small></span></button>`).join(''):
      `${matched.length?`<div class="picker-group">${t('스킬','SKILLS')} · ${provider().label}</div>${matched.map(skill=>`<button class="picker-item" data-action="select-skill" data-id="${skill.id}">${icon(skill.icon)}<span class="grow"><strong>${esc(skill.name)}</strong><small>${esc(tr(skill.description))}</small><small>${esc(skill.source)} · ${skillScope(skill)==='project'?t('프로젝트','Project'):t('사용자 전체','User-wide')}</small></span>${session().selected.includes(skill.id)?icon('Check'):`<span class="shortcut">${esc(provider().prefix)}</span>`}</button>`).join('')}`:''}
      ${commands.length?`<div class="picker-group">${t('명령','COMMANDS')}</div>${commands.map(([name,label,action])=>`<button class="picker-item" data-action="${action}" data-command="true">${icon('Terminal')}<span><strong>/${name}</strong><small>${label}</small></span></button>`).join('')}`:''}`;
    const empty=`<div class="empty-list">${icon('Search')}<h3>${t('검색 결과가 없습니다','No matches')}</h3><p>${t('다른 검색어를 입력하거나 확장 기능을 찾아보세요.','Try another search or browse extensions.')}</p>${button('market',t('마켓 탐색','Browse marketplaces'),'Plus')}</div>`;
    return modal(files?t('프로젝트 파일','Project files'):t('스킬과 명령','Skills and commands'),`<div class="picker-search"><div class="search-field">${icon('Search')}<input id="picker-search" value="${esc(state.pickerSearch)}" aria-label="${files?t('파일 검색','Search files'):t('스킬과 명령 검색','Search skills and commands')}" placeholder="${files?t('파일 이름으로 검색','Search file names'):t('이름이나 하고 싶은 작업으로 검색','Search by name or what you want to do')}" autocomplete="off"></div></div><div class="picker-results">${results||empty}</div><div class="picker-footer"><span>${t('선택해도 전송하지 않습니다','Selecting does not send')}</span>${button('extensions',t('관리','Manage'),'Settings2','')}</div>`);
  }
  function renderInstall() {
    const review=state.installPhase==='review', working=state.installPhase==='working';
    const sourceLabel=state.installType==='market'?t('등록된 마켓','Registered marketplace'):state.installType==='git'?t('Git 저장소 주소','Git repository URL'):t('PC의 폴더 경로','Folder path on the PC');
    const body=review||working?`<p>${t('다음 PC와 범위에 설치합니다. 같은 제공자 설정을 사용하는 다른 앱에도 반영됩니다.','Install on this PC and scope. Other apps sharing this provider setup will see the change.')}</p><div class="selected-summary"><p><strong>${esc(state.installingName||t('새 확장 기능','New extension'))}</strong></p><p>WORKSTATION · ${data.providers[state.installProvider].label}</p><p>${state.installScope==='project'?t('이 프로젝트 · C:/Projects/EZTerminal','This project · C:/Projects/EZTerminal'):t('사용자 전체','User-wide')}</p><code>${esc(state.installSource)}</code></div><p style="margin-top:14px">${t('등록된 출처와 포함 기능을 확인합니다. 설치만으로 대화를 보내지 않습니다.','Review the source and included capabilities. Installation does not send a message.')}</p>${working?`<div class="activity" role="status"><span class="spin">${icon('LoaderCircle')}</span>${t('설치 중… (시안)','Installing… (simulation)')}</div>`:''}`:
      `<p>${t('연결된 PC에 설치할 출처를 지정하세요.','Choose a source to install on the connected PC.')}</p>${state.installType!=='market'?`<div class="segmented" style="margin-top:16px">${button('install-type-git',t('Git 주소','Git URL'),null,'',`aria-pressed="${state.installType==='git'}"`)}${button('install-type-local',t('PC 폴더','PC folder'),null,'',`aria-pressed="${state.installType==='local'}"`)}</div>`:''}${field(sourceLabel,`<input id="install-source" value="${esc(state.installSource)}" ${state.installType==='market'?'readonly':''} placeholder="${state.installType==='local'?'C:/Tools/team-skills':'https://github.com/team/skills'}">`,state.installType==='local'?t('휴대전화 저장소가 아닌 WORKSTATION의 경로입니다.','This is a WORKSTATION path, not phone storage.'):t('출처는 설치 전에 다시 확인합니다.','The source is checked before installation.'))}<div class="field-grid">${field(t('제공자','Provider'),`<select id="install-provider">${Object.entries(data.providers).map(([id,p])=>`<option value="${id}" ${state.installProvider===id?'selected':''}>${p.label}</option>`).join('')}</select>`)}${field(t('설치 범위','Install scope'),`<select id="install-scope"><option value="project" ${state.installScope==='project'?'selected':''}>${t('이 프로젝트','This project')}</option><option value="user" ${state.installScope==='user'?'selected':''}>${t('사용자 전체','User-wide')}</option></select>`)}</div>${state.installError?`<div class="field-error" role="alert">${esc(state.installError)}</div>`:''}`;
    return modal(review||working?t('설치 내용 확인','Review installation'):t('확장 기능 추가','Add an extension'),body,cancel()+button(review?'confirm-install':'review-install',working?t('설치 중…','Installing…'):review?t('설치','Install'):t('설치 내용 확인','Review installation'),review?'Download':'ArrowRight','btn primary',working||state.offline?'disabled':''));
  }
  function renderMcpForm() {
    const draft=state.serverDraft;
    const existing=Boolean(draft.id);
    return modal(existing?t('MCP 서버 설정','MCP server settings'):t('MCP 서버 추가','Add an MCP server'),`<p>WORKSTATION · ${data.providers[state.managementProvider].label} · ${t('기존 제공자 설정과 공유','Shared provider settings')}</p>${field(t('서버 이름','Server name'),`<input id="server-name" value="${esc(draft.name)}" placeholder="Project tools">`)}${field(t('연결 방식','Transport'),`<select id="server-transport"><option value="HTTP" ${draft.transport==='HTTP'?'selected':''}>HTTP</option><option value="stdio" ${draft.transport==='stdio'?'selected':''}>${t('PC 프로그램 (stdio)','PC program (stdio)')}</option></select>`)}${field(draft.transport==='stdio'?t('프로그램','Program'):t('서버 주소','Server URL'),`<input id="server-address" value="${esc(draft.address)}" placeholder="${draft.transport==='stdio'?'node':'https://example.com/mcp'}">`)}${draft.transport==='stdio'?field(t('인자 · 한 줄에 하나','Arguments · one per line'),`<textarea id="server-args">${esc(draft.args||'')}</textarea>`):''}${field(t('적용 범위','Scope'),`<select id="server-scope"><option value="project" ${draft.scope==='project'?'selected':''}>${t('이 프로젝트','This project')}</option><option value="user" ${draft.scope==='user'?'selected':''}>${t('사용자 전체','User-wide')}</option></select>`)}<p style="margin-top:14px">${t('현재 대화에 바로 적용할 수 없는 변경은 새 대화부터 적용됨을 표시합니다.','Changes that cannot apply to this session are marked as applying to a new conversation.')}</p>${draft.error?`<div class="field-error" role="alert">${esc(draft.error)}</div>`:''}`,existing?button('toggle-mcp',draft.status==='disabled'?t('사용 설정','Enable'):t('사용 안 함','Disable'),'Plug','btn')+button('remove-mcp',t('삭제','Remove'),'Trash2','btn danger')+button('save-mcp',t('저장','Save'),'Check','btn primary'):cancel()+button('save-mcp',t('추가','Add'),'Plus','btn primary'));
  }
  const noteKey=()=>`${state.device}/${state.provider}/${state.scene}`;
  function renderReview() {
    const note=notes[noteKey()]||{status:'pending',text:''};
    return modal(t('시안 검토 · r3','Design review · r3'),`<div class="row between"><span class="badge">${t('검토 대기 · 제품 구현 전','Awaiting review · Before implementation')}</span><span class="review-count">${data.scenes.findIndex(scene=>scene.id===state.scene)+1} / ${data.scenes.length}</span></div><div class="review-description"><h3>${esc(tr(activeScene().name))}</h3><p>${esc(tr(activeScene().description))}</p></div><p>${t('모든 상태·모델·마켓·파일은 검토용 예시입니다. 실제 AI 실행, PC 파일 읽기, 설치 또는 설정 변경은 일어나지 않습니다.','All states, models, catalogs and files are review samples. No AI calls, PC file reads, installs or configuration changes occur.')}</p>
      <div class="field-grid">${field(t('표시 기기','Device'),`<select id="review-device"><option value="desktop" ${state.device==='desktop'?'selected':''}>Windows</option><option value="mobile" ${state.device==='mobile'?'selected':''}>Android</option></select>`)}${field(t('테마','Theme'),`<select id="review-theme">${['dark','light','high-contrast','matrix'].map(id=>`<option value="${id}" ${state.theme===id?'selected':''}>${id}</option>`).join('')}</select>`)}</div>
      ${field(t('이 화면의 검토 상태','Review state for this screen'),`<select id="review-status"><option value="pending" ${note.status==='pending'?'selected':''}>${t('미검토','Pending')}</option><option value="reviewed" ${note.status==='reviewed'?'selected':''}>${t('확인함','Reviewed')}</option><option value="changes" ${note.status==='changes'?'selected':''}>${t('수정 필요','Changes requested')}</option></select>`)}${field(t('의견','Notes'),`<textarea id="review-text" maxlength="4000" placeholder="${t('바꾸고 싶은 부분을 적어주세요','Describe what you would change')}">${esc(note.text)}</textarea>`)}
      <p style="margin-top:12px">${t('화면별 확인은 전체 시안 확정이나 구현 승인으로 처리하지 않습니다. 의견은 이 브라우저에 보관하고 파일로 내보낼 수 있습니다.','Reviewing a screen does not approve the whole design or authorize implementation. Notes stay in this browser and can be exported.')}</p>${!storageAvailable?`<p class="inline-warning">${t('브라우저 저장을 사용할 수 없습니다. 이 창을 닫기 전에 검토 기록을 내보내세요.','Browser storage is unavailable. Export the review before closing this window.')}</p>`:''}
      <div class="review-links"><a href="README.md" target="_blank" rel="noopener">${t('검토 안내','Review guide')}</a><a href="UI-CONTRACT.md" target="_blank" rel="noopener">${t('화면·동작 명세','UI contract')}</a><a href="SUPPORT.md" target="_blank" rel="noopener">${t('지원 근거·구현 경계','Support evidence')}</a></div>
      <div class="actions">${button('review-prev',t('이전 장면','Previous scene'),'ArrowLeft')}${button('review-next',t('다음 장면','Next scene'),'ArrowRight')}${button('export-review',t('기록 내보내기','Export review'),'Download')}${button('import-review',t('기록 가져오기','Import review'),'Upload')}<input id="review-file" type="file" accept="application/json,.json" hidden></div>`,button('save-review',t('기록 저장 후 닫기','Save notes and close'),'Check','btn primary'),true);
  }
  function focusOverlay() {
    const node=document.querySelector(state.overlay?.startsWith('remove')?'#dialog-cancel':state.overlay==='picker'?'#picker-search':'.dialog input:not([type=file]), .dialog select, .dialog textarea, .dialog [data-action="close"]');
    node?.focus({preventScroll:true});
    if (state.overlay==='copy') document.getElementById('copy-text')?.select();
  }
  function openOverlay(name,id='') {
    captureView();
    const focused=document.activeElement;
    beforeOverlay={id:focused?.id,action:focused?.dataset?.action,item:focused?.dataset?.id};
    state.overlay=name; state.overlayId=id;
    if(name==='picker') state.pickerSearch='';
    render(); focusOverlay();
  }
  function closeOverlay(focus=true) {
    if(state.overlay==='review') saveNotes();
    state.overlay=null;state.trigger=null; render();
    if(!focus)return;
    const target=beforeOverlay?.id?document.getElementById(beforeOverlay.id):[...document.querySelectorAll('[data-action]')].find(node=>node.dataset.action===beforeOverlay?.action&&node.dataset.id===beforeOverlay?.item);
    (target||document.getElementById('draft')||document.getElementById('content'))?.focus({preventScroll:true});
  }
  function toast(message) {
    clearTimeout(toastTimer);document.getElementById('toast').textContent=message;
    toastTimer=setTimeout(()=>{document.getElementById('toast').textContent='';},3500);
  }
  function navigate(route,tab,capture=true) { if(capture)captureView(); state.overlay=null;state.trigger=null;state.route=route;if(tab)state.tab=tab;render();document.getElementById('content')?.focus({preventScroll:true}); }
  function addSkill(id) {
    captureView();const s=session();if(!skills().some(skill=>skill.id===id))return;
    if(!s.selected.includes(id))s.selected.push(id);
    consumeTrigger();
    state.overlay=null;state.route='chat';render();document.getElementById('draft')?.focus({preventScroll:true});
  }
  function consumeTrigger() {
    const s=session(), trigger=state.trigger;
    if(!trigger)return;
    s.draft=s.draft.slice(0,trigger.start)+s.draft.slice(trigger.end);
    s.selection=[trigger.start,trigger.start];state.trigger=null;
    const input=document.getElementById('draft');
    if(input){input.value=s.draft;input.setSelectionRange(...s.selection);}
  }
  function startSimulation(s) {
    if(journey.startResponse(s)){modelTurns++;return;}
    const stamp=generation;
    const turn=(s.simulationTurn||0)+1;s.simulationTurn=turn;
    s.status='working';modelTurns++;
    s.messages.push({role:'assistant',text:t('프로젝트 지침과 화면 구성을 확인하겠습니다.','I’ll check the project instructions and screen structure.'),tools:true});
    setTimeout(()=>{
      if(stamp!==generation||s.status!=='working'||turn!==s.simulationTurn)return;
      s.status='completed';s.messages.push({role:'assistant',text:t('검토를 마쳤습니다. 입력 필드의 이름과 포커스 이동 순서를 확인했습니다.\n\n비밀번호 표시 버튼에 이름을 추가하고, 오류 안내를 해당 입력 필드와 연결하는 것을 제안합니다.','Review complete. I checked field names and focus order.\n\nAdd a name to the password visibility button and connect each error message to its field.')});
      if(s.queue.length){s.messages.push({role:'user',...s.queue.shift()});startSimulation(s);}
      if(session()===s){captureView();render();}
    },1600);
  }
  function send() {
    captureView();if(!canSend())return;const s=session();const text=s.draft.trim()||t('첨부한 파일을 확인해줘.','Review the attached file.');
    const packet={text,skills:[...s.selected],attachments:[...s.attachments],reply:s.reply};
    if(s.status==='working')s.queue.push(packet);
    else {s.messages.push({role:'user',...packet});s.title||=text.slice(0,34);startSimulation(s);}
    s.draft='';s.selection=[0,0];s.attachments=[];s.reply='';s.selected=[];render();document.getElementById('draft')?.focus({preventScroll:true});
  }
  function saveNotes() {
    const text=document.getElementById('review-text'),status=document.getElementById('review-status');
    if(text&&status)notes[noteKey()]={status:status.value,text:text.value.slice(0,4000)};
    try{localStorage.setItem('ezterminal:agent-chat-r4:review',JSON.stringify(notes));storageAvailable=true;}catch{storageAvailable=false;}
  }
  function readMcpForm() {
    const d=state.serverDraft;
    d.name=document.getElementById('server-name')?.value??d.name;
    d.address=document.getElementById('server-address')?.value??d.address;
    d.args=document.getElementById('server-args')?.value??d.args;
    d.scope=document.getElementById('server-scope')?.value??d.scope;
  }
  function prepareInstall(type,id) {
    state.installPhase='edit';state.installError='';state.installType=type;state.installProvider=state.managementProvider;state.installScope='project';
    const item=data.market.find(item=>item.id===id);
    state.installingId=id||'accessibility';state.installingName=item?.name||'Accessibility toolkit';
    state.installSource=type==='market'?`${item.source}/${item.id}`:type==='local'?'C:/Tools/accessibility-toolkit':'https://github.com/example/accessibility-toolkit';
    openOverlay('install');
  }
  function onAction(action,node) {
    if(journey.action(action,node))return;
    const s=session(),id=node?.dataset?.id,index=Number(node?.dataset?.index||0);
    if(node?.dataset?.command) consumeTrigger();
    switch(action) {
      case 'close': closeOverlay();break;
      case 'skin': captureView();state.skin=state.skin==='bubble'?'cli':'bubble';updateUrl();render();break;
      case 'language': captureView();state.lang=state.lang==='ko'?'en':'ko';updateUrl();render();break;
      case 'device-desktop': case 'device-mobile': captureView();state.device=action==='device-mobile'?'mobile':'desktop';updateUrl();render();break;
      case 'skills': state.trigger=null;state.pickerKind='skills';openOverlay('picker');break;
      case 'files': state.trigger=null;state.pickerKind='files';openOverlay('picker');break;
      case 'select-skill': case 'use-managed-skill': addSkill(id);break;
      case 'remove-skill': captureView();s.selected=s.selected.filter(value=>value!==id);render();break;
      case 'remove-attachment': captureView();s.attachments.splice(index,1);render();break;
      case 'remove-reply': captureView();s.reply='';render();break;
      case 'add-file': {
        captureView();const name=node.dataset.name;if(!s.attachments.includes(name))s.attachments.push(name);consumeTrigger();state.overlay=null;render();document.getElementById('draft')?.focus();break;
      }
      case 'add-sample-image': if(!s.attachments.includes('login-screen.png'))s.attachments.push('login-screen.png');closeOverlay();break;
      case 'model': case 'permission': case 'provider': case 'provider-info': case 'attachment': case 'navigation': case 'about-scope': case 'review': openOverlay(action);break;
      case 'save-model': s.model=document.getElementById('model-choice').value;if(state.reasoningSupported)s.effort=document.getElementById('effort-choice').value;closeOverlay();break;
      case 'save-permission': s.permission=document.querySelector('input[name=permission]:checked').value;closeOverlay();break;
      case 'choose-provider': {
        if(s.messages.length&&s.provider!==id){captureView();state.provider=id;state.sessionId=`draft-${++state.counter}`;state.sessions[state.sessionId]=freshSession(state.sessionId,id);}
        else {s.provider=id;s.model=data.providers[id].model;s.effort='high';state.provider=id;}
        state.overlay=null;updateUrl();render();break;
      }
      case 'prompt-explore': case 'prompt-ui': case 'prompt-debug': captureView();s.draft=action==='prompt-explore'?t('이 프로젝트의 구조와 실행 방법을 설명해줘.','Explain the structure and how to run this project.'):action==='prompt-ui'?t('로그인 화면의 접근성과 입력 흐름을 검토해줘.','Review the login screen’s accessibility and input flow.'):t('문제를 재현하고 원인을 함께 찾아줘.','Help reproduce the issue and find its cause.');if(action!=='prompt-explore')s.selected=[action==='prompt-ui'?'frontend':'diagnose'].filter(id=>skills().some(skill=>skill.id===id));s.selection=[s.draft.length,s.draft.length];render();document.getElementById('draft')?.focus();break;
      case 'refresh': state.catalogState='ready';closeOverlay();toast(t('기능 목록을 다시 확인했습니다. (시안)','Capabilities refreshed. (Simulation)'));break;
      case 'chat': navigate('chat');break;
      case 'extensions': state.search='';navigate('extensions');break;
      case 'mcp': state.managementProvider=s.provider;navigate('extensions','mcp');break;
      case 'market': state.catalogMode='market';state.search='';navigate('extensions','plugins');break;
      case 'manager-tab': state.tab=id;state.search='';render();break;
      case 'catalog-installed': case 'catalog-market': state.catalogMode=action==='catalog-market'?'market':'installed';render();break;
      case 'reset-filter': state.search='';state.scope='all';render();break;
      case 'new-chat': captureView();state.sessionId=`draft-${++state.counter}`;state.sessions[state.sessionId]=freshSession(state.sessionId);navigate('chat',null,false);document.getElementById('draft')?.focus();break;
      case 'session': captureView();state.sessionId=id;state.provider=session().provider;navigate('chat',null,false);break;
      case 'history': captureView();if(!state.sessions.history){state.sessions.history=freshSession('history');seedConversation(state.sessions.history,true);state.sessions.history.status='completed';}state.sessionId='history';navigate('chat',null,false);break;
      case 'reply': captureView();s.reply=s.messages[index].text;render();document.getElementById('draft')?.focus();break;
      case 'reuse': captureView();s.draft=s.messages[index].text;s.selection=[s.draft.length,s.draft.length];render();document.getElementById('draft')?.focus();break;
      case 'copy-message': openOverlay('copy',String(index));break;
      case 'stop': captureView();s.status='interrupted';render();break;
      case 'continue': captureView();startSimulation(s);render();break;
      case 'queue-remove': captureView();s.queue.splice(index,1);render();break;
      case 'queue-edit': {captureView();const item=s.queue.splice(index,1)[0];s.draft=[s.draft,item.text].filter(Boolean).join('\n');s.selected=[...new Set([...s.selected,...item.skills])];s.attachments=[...new Set([...s.attachments,...item.attachments])];if(item.reply)s.reply=[s.reply,item.reply].filter(Boolean).join('\n');s.selection=[s.draft.length,s.draft.length];render();document.getElementById('draft')?.focus();break;}
      case 'interrupt-send': if(s.queue.length){captureView();s.status='interrupted';s.messages.push({role:'user',...s.queue.shift()});startSimulation(s);render();}break;
      case 'answer': if(s.answer){s.question='answered';s.messages.push({role:'user',text:s.answer==='login'?t('로그인 화면부터 확인해줘.','Start with the login screen.'):s.answer==='both'?t('로그인과 회원가입을 함께 확인해줘.','Review login and sign-up together.'):s.answer});startSimulation(s);render();}break;
      case 'allow': case 'deny': s.approval=action;s.messages.push({role:'assistant',text:action==='allow'?t('이번 파일 변경을 허용했습니다.','The file change was allowed for this request.'):t('파일 변경을 거절했습니다. 변경 없이 검토 내용만 정리합니다.','The file change was denied. I’ll provide the review without making changes.')});s.status='completed';render();break;
      case 'reconnect': captureView();state.offline=false;render();toast(t('다시 연결했습니다. 초안은 전송하지 않았습니다.','Reconnected. The draft was not sent.'));break;
      case 'reconcile': s.uncertain=false;s.messages.push({role:'user',text:s.draft});s.draft='';s.selection=[0,0];s.messages.push({role:'assistant',text:t('PC 기록에서 메시지가 도착했음을 확인했습니다. 다시 전송하지 않았습니다.','The PC record confirms delivery. The message was not sent again.')});render();break;
      case 'skill-detail': openOverlay('skill-detail',id);break;
      case 'toggle-skill-install': {const item=state.catalogs[state.managementProvider].find(skill=>skill.id===id);if(item)item.enabled=item.enabled===false;closeOverlay();break;}
      case 'plugin-detail': state.activePlugin=id||'ezpowers';navigate('plugin');break;
      case 'toggle-plugin': state.packages[state.managementProvider][state.activePlugin].enabled=!state.packages[state.managementProvider][state.activePlugin].enabled;render();toast(t('사용 설정을 변경했습니다. (시안)','Enablement changed. (Simulation)'));break;
      case 'update-plugin': state.packages[state.managementProvider][state.activePlugin].version='5.8.1';state.nextChat=true;render();break;
      case 'remove-plugin': openOverlay('remove-plugin');break;
      case 'confirm-remove-plugin': state.packages[state.managementProvider][state.activePlugin].installed=false;state.packages[state.managementProvider][state.activePlugin].enabled=false;navigate('extensions','plugins');toast(t('플러그인을 삭제했습니다. 대화 기록은 유지됩니다. (시안)','Plugin removed; history preserved. (Simulation)'));break;
      case 'remove-skill-install': openOverlay('remove-skill-install',id);break;
      case 'confirm-remove-skill': state.catalogs[state.managementProvider]=state.catalogs[state.managementProvider].filter(skill=>skill.id!==state.overlayId);closeOverlay();break;
      case 'install-source': prepareInstall('git');break;
      case 'install-market': prepareInstall('market',id);break;
      case 'install-type-git': case 'install-type-local': state.installType=action==='install-type-local'?'local':'git';state.installSource=state.installType==='local'?'C:/Tools/accessibility-toolkit':'https://github.com/example/accessibility-toolkit';state.installError='';renderOverlay();focusOverlay();break;
      case 'review-install': {
        state.installSource=document.getElementById('install-source').value.trim();state.installScope=document.getElementById('install-scope').value;state.installProvider=document.getElementById('install-provider').value;
        const valid=state.installType==='market'||(state.installType==='local'?/^[A-Za-z]:[\\/]/.test(state.installSource):/^(https:\/\/[^\s]+|git@[^\s]+:[^\s]+)$/.test(state.installSource));
        state.installError=valid?'':t('유효한 Git 주소 또는 PC의 절대 폴더 경로를 입력하세요.','Enter a valid Git URL or an absolute PC folder path.');if(valid)state.installPhase='review';renderOverlay();focusOverlay();break;
      }
      case 'confirm-install': {
        if(state.installPhase!=='review'||state.offline)return;
        state.installPhase='working';const stamp=generation;const target=state.installProvider,scope=state.installScope,key=state.installingId||'accessibility',name=state.installingName||'Accessibility toolkit';renderOverlay();
        setTimeout(()=>{if(stamp!==generation)return;state.packages[target][key]={installed:true,enabled:true,version:'1.0.0',scope};if(key!=='ezpowers'&&!state.catalogs[target].some(skill=>skill.id===key))state.catalogs[target].push({id:key,name:key==='accessibility'?'accessibility-review':'repository-notes',token:key==='accessibility'?'accessibility-review':'repository-notes',description:key==='accessibility'?['키보드와 화면 접근성을 검토합니다.','Review keyboard and screen accessibility.']:['저장소의 변경 기록을 정리합니다.','Organize repository change notes.'],source:name,kind:'plugin',packageId:key,icon:'ShieldCheck'});state.simulatedInstalls++;state.managementProvider=target;state.overlay=null;state.catalogMode='installed';state.route='extensions';state.tab='skills';state.search='';render();toast(t('설치했습니다. 원래 대화로 돌아가 바로 선택할 수 있습니다. (시안)','Installed. Return to your conversation to select it. (Simulation)'));},700);break;
      }
      case 'add-mcp': state.serverDraft={id:'',name:'',transport:'HTTP',address:'',args:'',scope:'project',status:'needs-auth'};openOverlay('mcp-edit');break;
      case 'edit-mcp': {const server=state.servers[state.managementProvider].find(item=>item.id===id);state.serverDraft={...server,scope:server.scope||(id==='project'?'project':'user'),...(server.transport==='stdio'?{address:'node',args:'./tools/project-mcp.mjs'}:{args:''})};openOverlay('mcp-edit',id);break;}
      case 'mcp-auth': openOverlay('mcp-auth',id||'design');break;
      case 'reconnect-mcp': {const server=state.servers[state.managementProvider].find(item=>item.id===id);if(server)server.status='connected';render();toast(t('다시 연결했습니다. (시안)','Reconnected. (Simulation)'));break;}
      case 'auth-instructions': toast(t('PC의 제공자 설정 → MCP → Design library에서 로그인하세요. (시안)','On the PC, open provider settings → MCP → Design library and sign in. (Simulation)'));break;
      case 'check-auth': {const server=state.servers[state.managementProvider].find(item=>item.id===state.overlayId);if(server){server.status='connected';server.tools=3;}closeOverlay();toast(t('인증 완료 상태를 표시합니다. (시안)','Showing the authenticated state. (Simulation)'));break;}
      case 'save-mcp': {readMcpForm();const d=state.serverDraft;const valid=d.name.trim()&&(d.transport==='stdio'?d.address.trim():/^https:\/\/\S+$/.test(d.address));if(!valid){d.error=t('서버 이름과 유효한 주소 또는 프로그램을 입력하세요.','Enter a name and a valid URL or program.');renderOverlay();focusOverlay();break;}const list=state.servers[state.managementProvider];const existing=list.find(item=>item.id===d.id);const saved={...d,id:d.id||`server-${list.length+1}`,description:[t('직접 추가한 서버','Custom server'),t('직접 추가한 서버','Custom server')],tools:0,status:d.status||'needs-auth'};if(existing)Object.assign(existing,saved);else list.push(saved);closeOverlay();toast(t('MCP 설정을 저장했습니다. (시안)','MCP settings saved. (Simulation)'));break;}
      case 'toggle-mcp': {const target=state.servers[state.managementProvider].find(item=>item.id===state.serverDraft.id);if(target)target.status=target.status==='disabled'?'needs-auth':'disabled';closeOverlay();break;}
      case 'remove-mcp': openOverlay('remove-mcp-confirm');break;
      case 'confirm-remove-mcp': state.servers[state.managementProvider]=state.servers[state.managementProvider].filter(item=>item.id!==state.serverDraft.id);closeOverlay();break;
      case 'resolve-conflict': openOverlay('conflict');break;
      case 'reload-settings': state.settingsConflict=false;closeOverlay();toast(t('최신 설정을 불러왔습니다. 변경은 적용하지 않았습니다.','Latest settings loaded. Your change has not been applied.'));break;
      case 'save-review': saveNotes();closeOverlay();toast(t(storageAvailable?'검토 기록을 저장했습니다.':'이 창에 기록을 보관했습니다. 파일로 내보내 주세요.',storageAvailable?'Review notes saved.':'Notes kept in this window. Please export them.'));break;
      case 'review-prev': case 'review-next': {saveNotes();const current=data.scenes.findIndex(scene=>scene.id===state.scene);resetScene(data.scenes[(current+(action==='review-next'?1:-1)+data.scenes.length)%data.scenes.length].id);break;}
      case 'export-review': {saveNotes();const blob=new Blob([JSON.stringify({schemaVersion:1,design:'ezterminal-v2-agent-chat-r4',approved:false,notes},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='ezterminal-agent-chat-r4-review.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);break;}
      case 'import-review': document.getElementById('review-file').click();break;
    }
  }
  document.addEventListener('click',event=>{
    const node=event.target.closest?.('[data-action]');
    if(node&&!node.disabled){event.preventDefault();onAction(node.dataset.action,node);}
    else if(event.target.classList?.contains('overlay-shade')&&state.installPhase!=='working')closeOverlay();
  });
  document.addEventListener('submit',event=>{if(event.target.id==='chat-form'){event.preventDefault();send();}});
  document.addEventListener('input',event=>{
    const input=event.target;
    if(input.id==='draft'){
      const s=session();s.draft=input.value;s.selection=[input.selectionStart,input.selectionEnd];
      document.getElementById('send').disabled=!canSend();
      const prefix=input.value.slice(0,input.selectionStart);
      const match=prefix.match(/(?:^|\s)([/@])([^\s]*)$/);
      if(match&&match[2]===''){
        state.trigger={start:prefix.length-1,end:prefix.length,kind:match[1]==='/'?'skills':'files'};
        state.pickerKind=state.trigger.kind;openOverlay('picker');
      }
    }
    if(input.id==='picker-search'){
      state.pickerSearch=input.value;const pos=input.selectionStart;renderOverlay();const replacement=document.getElementById('picker-search');replacement.focus();replacement.setSelectionRange(pos,pos);
    }
    if(input.id==='extension-search'){
      state.search=input.value;const pos=input.selectionStart;render();const replacement=document.getElementById('extension-search');replacement.focus();replacement.setSelectionRange(pos,pos);
    }
    if(input.id==='free-answer'){session().answer=input.value;document.querySelector('[data-action="answer"]').disabled=!input.value.trim();document.querySelectorAll('input[name=answer]').forEach(radio=>radio.checked=false);}
  });
  document.addEventListener('change',async event=>{
    const input=event.target;
    switch(input.id){
      case 'scene-select': resetScene(input.value);if(state.overlay)focusOverlay();break;
      case 'theme-select': captureView();state.theme=input.value;updateUrl();render();break;
      case 'management-provider': state.managementProvider=input.value;state.search='';render();break;
      case 'scope-filter': state.scope=input.value;render();break;
      case 'review-device': saveNotes();state.device=input.value;updateUrl();render();focusOverlay();break;
      case 'review-theme': saveNotes();state.theme=input.value;updateUrl();render();focusOverlay();break;
      case 'server-transport': readMcpForm();state.serverDraft.transport=input.value;state.serverDraft.address=input.value==='stdio'?'node':'https://example.com/mcp';renderOverlay();focusOverlay();break;
      case 'review-file': {
        const file=input.files?.[0];if(!file)break;
        try{
          if(file.size>128*1024)throw new Error('size');
          const imported=JSON.parse(await file.text());
          if(imported.schemaVersion!==1||imported.design!=='ezterminal-v2-agent-chat-r4'||!imported.notes||typeof imported.notes!=='object'||Array.isArray(imported.notes))throw new Error('shape');
          const next={};
          for(const [key,value]of Object.entries(imported.notes)){
            const [device,providerId,scene,extra]=key.split('/');
            if(extra||!['desktop','mobile'].includes(device)||!['codex','claude'].includes(providerId)||!data.scenes.some(item=>item.id===scene)||!['pending','reviewed','changes'].includes(value?.status)||typeof value?.text!=='string'||value.text.length>4000)throw new Error('entry');
            next[key]={status:value.status,text:value.text};
          }
          saveNotes();notes={...notes,...next};try{localStorage.setItem('ezterminal:agent-chat-r4:review',JSON.stringify(notes));}catch{storageAvailable=false;}
          renderOverlay();focusOverlay();toast(t('검토 의견을 가져왔습니다. 승인 상태는 변경하지 않습니다.','Review notes imported. Approval status is unchanged.'));
        }catch{toast(t('r2 검토 기록 파일을 확인하세요. 기존 의견은 유지합니다.','Check the r3 review file. Existing notes are preserved.'));}break;
      }
    }
    if(input.name==='answer'){session().answer=input.value;document.querySelector('[data-action="answer"]').disabled=false;document.getElementById('free-answer').value='';}
  });
  document.addEventListener('toggle',event=>{if(event.target.classList?.contains('tool-group'))session().toolOpen=event.target.open;},true);
  document.addEventListener('keydown',event=>{
    if(event.isComposing||event.keyCode===229)return;
    if(state.overlay){
      if(event.key==='Escape'&&state.installPhase!=='working'){event.preventDefault();closeOverlay();return;}
      const dialog=document.querySelector('.dialog');if(!dialog)return;
      const focusables=[...dialog.querySelectorAll('button:not(:disabled),input:not([type=file]),textarea,select,a[href]')].filter(node=>node.getClientRects().length);
      if(event.key==='Tab'&&focusables.length){
        const first=focusables[0],last=focusables.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
      if(state.overlay==='picker'&&['ArrowDown','ArrowUp'].includes(event.key)){
        const items=[...dialog.querySelectorAll('.picker-item')];if(!items.length)return;event.preventDefault();const current=items.indexOf(document.activeElement);items[(current+(event.key==='ArrowDown'?1:items.length-1)+items.length)%items.length].focus();
      }
      if(state.overlay==='picker'&&event.key==='Enter'&&document.activeElement.id==='picker-search'){event.preventDefault();dialog.querySelector('.picker-item')?.click();}
      return;
    }
    if(event.target.id==='draft'&&event.key==='Enter'&&!event.shiftKey&&state.device==='desktop'){event.preventDefault();send();}
  });
  window.addEventListener('beforeunload',()=>{if(state.overlay==='review')saveNotes();});
  // Read-only inspection for reference verification. Not a production API.
  const journey=window.createJourney({state,session,t,esc,icon,button,ib,badge,modal,cancel,openOverlay,render,captureView,updateUrl,freshSession,toast,startSimulation,noteTurn:()=>modelTurns++});
  window.chatReview={getState:()=>structuredClone({scene:state.scene,route:state.route,session:session(),sessions:state.sessions,offline:state.offline,modelTurns,simulatedInstalls:state.simulatedInstalls,selectedProvider:state.managementProvider,catalogs:state.catalogs,notes,workflow:journey.inspect(),approved:false}),scenes:data.scenes.map(item=>item.id)};
  resetScene(params.get('scene')||'work-home');
  if(state.overlay)focusOverlay();
})();
