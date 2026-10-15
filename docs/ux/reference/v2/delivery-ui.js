window.createDeliveryReview = function(h) {
  const {data,esc,pill,button,row,check,miniMock,modal,navigate,refresh,canInteract,getScreen,shell,titleBlock}=h;
  const state={mode:'team',policy:'review',profile:'builder',selected:null,tab:'integration',attempt:1,repairLimit:2};
  const editor=window.createProfileReview({...h,onSave:()=>{const r=document.querySelector('#execution-readiness');if(r)r.outerHTML=readiness();}});
  const profile=id=>editor.profile(id);
  const specFor=id=>data.aiProfiles.find(p=>p.id===(['windows','android'].includes(id)?'builder':id));
  const modes=[['single','단일 AI'],['team','분업 팀'],['compare','후보 비교'],['review','독립 검토']];
  const roleName=id=>({windows:'Windows 구현 담당',android:'Android 구현 담당'}[id]||specFor(id)?.name||id);
  const select=(label,id,options,value)=>`<label class="field"><span class="label">${label}</span><select id="${id}">${options.map(([v,n])=>`<option value="${v}" ${value===v?'selected':''}>${n}</option>`).join('')}</select></label>`;
  const activeRoles=()=>({single:['builder'],team:['coordinator','windows','android'],compare:['windows','android'],review:['reviewer']}[state.mode]);
  const isReady=()=>activeRoles().every(id=>profile(id).model!=='unsupported'&&profile(id).provider!=='missing');
  const readiness=()=>`<div class="callout ${isReady()?'':'warn'}" id="execution-readiness" role="status">${isReady()?'설정 준비됨 · 예시 연결의 지원 옵션 확인':'설정 필요 · 미지원 모델 또는 연결되지 않은 AI가 있습니다. 해당 역할을 수정하세요.'}</div>`;
  const receipt=(id='builder')=>`<div class="execution-receipt"><strong>${roleName(id)} · 시도 ${state.attempt}</strong><p>요청: 프로젝트 기본 AI / 기본 모델 / 지원 추론값<br>적용: 프로젝트 기본 AI / 기본 모델 / 지원 추론값 · 일치 예시</p><small>profile v1 · 지시 v1 · 설계 v1 · 결과 8d2b<br>관측 사용량: 미확인 · 검토용 기록</small>${button('지시·참조 보기','simulate:role-'+id,'small subtle')}</div>`;
  const evidence=()=>`<div class="execution-evidence"><h3>이 결과의 검증 근거</h3><p class="tiny muted">결과 8d2b에 연결된 예시 · 실제 검사 결과 아님</p>${[['입력·스킨 보존','Windows · 기능 검사','통과 예시'],['재연결·Back·입력','Android · 기기 검사','통과 예시'],['설계·코드 독립 검토','별도 검토 세션','통과 예시']].map(([a,b,c])=>`<div class="execution-check"><span><strong>${a}</strong><small>${b}</small></span>${pill(c,'good')}</div>`).join('')}<div class="row wrap">${button('검증 상세','simulate:evidence','small subtle')}${button('검토 만료 예시','simulate:stale-evidence','small quiet')}</div></div>`;
  const fields=id=>editor.fields(id);
  const bindFields=(root,id)=>editor.bindFields(root,id);
  function setup() {
    return `<div class="content-pad execution-content"><div class="stepper"><span class="current">01 기준·팀 설정</span><span>02 작업·검증 확인</span><span>03 실행 시작</span></div><div class="grid2"><section class="panel"><h3>실행 기준</h3><p>설계 v1 · 기능 F02 · 화면 D18 / M04<br>기준 9c3a → 로컬 통합 후보</p>${select('팀 운영 방식','execution-mode',modes,state.mode)}${select('진행 정책','execution-policy',[['review','단계별 검토 · 기본'],['autonomous','자율 진행 · 로컬 통합까지']],state.policy)}<div class="callout">팀 구성과 진행 정책은 따로 선택합니다. 후보 비교는 같은 기준으로 독립 결과를 만듭니다.</div></section><section class="panel"><h3>역할별 AI 설정</h3>${activeRoles().map(id=>row(state.mode==='compare'?(id==='windows'?'후보 A':'후보 B'):roleName(id),'프로젝트 기본 상속 · 지시 v1','simulate:role-'+id,'chat')).join('')}<small>선택한 방식의 참여 역할만 점검합니다. 후속 검토·통합 담당은 해당 단계 진입 전에 확인합니다. 최대 동시 실행 4.</small></section></div><div class="section-label">실행 전 확인</div>${readiness()}<div class="grid2 execution-summary"><section><h3>담당에게 전달할 작업</h3>${row('T04 · 대화 스킨','입력·출력·허용 파일·검증 조건 확인','D17','file')}${row('T05 · Android 대화','공통 계약 통합 이후 배정','M07','phone')}</section><section><h3>이번 실행의 종료 지점</h3><p>전체 실행 시간 제한 없음 · 검증 실패 추가 재시도 ${state.repairLimit}회</p><p>독립 검토 → 로컬 통합 → 통합 후 검증</p><small>main 반영·push·배포는 별도 동작입니다. 화면을 열거나 설정을 바꾸는 것만으로 실행하지 않습니다.</small></section></div></div>`;
  }
  function task() {
    return `<div class="content-pad execution-content"><div class="row between"><span class="id-tag">T04 · F02 / D18 / M04</span>${pill('검토 대기','warn')}</div><h2>말풍선·터미널형 대화 스킨</h2><div class="grid2"><section class="panel"><h3>입력 → 산출물</h3><p>입력: 설계 v1 · 대화 계약 T01 / 9c3a<br>산출물: 변경 8d2b · diff · 검증 보고서</p><h3>변경 범위</h3><p>대화 표현·보기 설정·모바일 표현. 공통 실행 계약 변경은 대표 AI에게 요청합니다.</p><h3>완료 조건</h3>${['세션·입력·첨부 보존','Windows·Android 두 스킨 검증','AI 입력과 실제 터미널 구분'].map(check).join('')}${button('독립 검토로 이동','D20','primary small')}</section><section class="panel">${receipt()}<div class="divider"></div><h3>작업 위치와 인계</h3><p>agent/conversation-skins · 분리된 사본<br>선행 T01 완료 · 후속 통합은 검토 후 시작</p><div class="row wrap">${button('변경 보기','D22','small subtle')}${button('새 시도로 재시도','simulate:retry-attempt','small subtle')}</div></section></div>${evidence()}</div>`;
  }
  function compare() {
    return `<div class="content-pad execution-content"><h2>같은 기준으로 만든 후보 비교</h2><p>설계 v1 · T04 · 기준 9c3a · 공통 검증 3개</p><div class="comparison">${['A','B'].map((id,i)=>`<section class="panel"><div class="row between"><h3>후보 ${id}</h3>${pill(state.selected===id?'채택됨 · 검토 대기':i?'검증 부족':'검토 가능',i?'warn':'good')}</div><div class="drawing execution-candidate">${miniMock(i)}</div><p>${i?'다른 연결 AI / 모델 B':'프로젝트 기본 AI / 모델 A'} · 설정 예시<br>결과 ${i?'7f1a':'8d2b'} · 사용량 미확인</p><p>${i?'Android 입력 검사 실패 · 재시도 필요':'입력·스킨·Android 검사 통과 예시'}</p>${i?button('실패 근거 보기','simulate:candidate-failed','subtle'):button('후보 A 채택','simulate:adopt-A','primary')}${button('변경 비교','D22','small quiet')}</section>`).join('')}</div><div class="callout">채택한 후보를 독립 검토에 전달합니다. 다른 후보와 실패 기록을 보존하며 통합은 검토 이후에 진행합니다.</div>${state.selected?button('채택한 결과 검토','D20','primary'):''}</div>`;
  }
  function integration() {
    const requested=new URLSearchParams(location.hash.split('?')[1]||'').get('deliveryTab');
    if(requested)state.tab=requested;
    const tabs=[['integration','통합 결과'],['release','출시 준비'],['recovery','충돌·복구']];
    let body='';
    if(state.tab==='release')body=`<h2>출시 준비를 확인합니다</h2><p>같은 통합 revision으로 만든 Windows·Android 결과물을 검토합니다.</p><div class="grid2"><section class="panel"><h3>설치 파일과 버전</h3>${row('Windows 설치 패키지','버전·source revision·해시·위치','simulate:release-evidence','file')}${row('Android APK','버전·서명·source revision·해시','simulate:release-evidence','phone')}<small>이 화면의 파일과 수치는 설계 예시입니다.</small></section><section class="panel"><h3>필수 확인</h3>${['새 설치·기존 설치 업데이트','기획·세션·설정 데이터 이전','Android 재연결·앱 강제종료 복구'].map(check).join('')}<p>${pill('복구 실증 미실행','warn')}</p>${button('남은 검증과 담당 보기','simulate:release-evidence','subtle')}</section></div><div class="callout warn">출시 준비 미완료 · 필수 복구 검증이 남아 있습니다. 검토가 끝나면 별도 반영·발행 동작으로 이어갑니다.</div>`;
    else if(state.tab==='recovery')body=`<h2>통합 후보를 격리했습니다</h2><p>예시: T05 통합 검사 실패 · 직전 성공 지점 71ac 유지</p><div class="panel"><h3>보존한 내용</h3>${['작업별 원본과 검토 기록','충돌한 후보의 파일·로그·revision','사용자 작업과 직전 성공 결과'].map(check).join('')}<h3>다시 진행하는 순서</h3><p>실패 근거 확인 → 담당 수정 → 독립 재검토 → 새 통합 후보 → 통합 후 검사</p><div class="row wrap">${button('수정 작업 열기','D17','primary')}${button('복구 계획 보기','simulate:integration-restore','subtle')}</div></div>`;
    else body=`<h2>로컬 통합 결과를 검토합니다</h2><p>설계 v1 · 통합 후보 c40e · 검토용 결과 예시</p><div class="grid2"><section class="panel"><h3>포함된 결과</h3>${row('T04 · 대화 스킨','8d2b · 검토 완료 예시','D20','check')}${row('T05 · Android 대화','b75c · 검토 완료 예시','M08','check')}<p>직전 성공: 71ac<br>후보 위치: integration/ezterminal-2.0</p></section><section class="panel"><h3>통합 후 검사</h3>${['기능·계약 회귀','Windows·Android 흐름','세션·데이터 보존'].map(check).join('')}<small>통과 예시 · 대상 revision c40e</small></section></div><div class="callout">자율 진행은 로컬 통합과 검증 완료에서 멈춥니다. main·push·외부 배포를 자동 실행하지 않습니다.</div>`;
    return `<div class="content-pad execution-content"><div class="execution-tabs" role="group" aria-label="통합 상세">${tabs.map(([id,n])=>`<button class="btn ${state.tab===id?'primary':'subtle'}" data-delivery-tab="${id}" aria-pressed="${state.tab===id}">${n}</button>`).join('')}</div>${body}</div>`;
  }
  function provider() {
    return `<div class="content-pad execution-content"><h2>AI 역할과 다음 실행 설정</h2><p>같은 AI를 여러 역할에 쓰거나 역할마다 다른 모델을 선택할 수 있습니다.</p>${select('편집할 역할','execution-profile',data.aiProfiles.map(p=>[p.id,p.name]),state.profile)}<section class="panel execution-profile-form"><h3>${roleName(state.profile)} · 역할 프로필</h3>${fields(state.profile)}</section>${readiness()}<label class="field"><span class="label">새 작업의 검증 실패 추가 재시도 횟수</span><input id="repair-limit" type="number" min="0" step="1" value="${state.repairLimit}"></label><p class="tiny muted">기본 2회 · 전체 실행 시간 제한 없음 · 현재 실행은 기존 정책 유지</p><button class="btn subtle" id="save-repair-limit">재시도 설정 저장</button><p id="repair-setting-status" role="status"></p><h3>팀 프리셋</h3>${select('다음 실행의 팀 방식','execution-mode',modes,state.mode)}<p>작업별 범위와 진행 정책은 실행 준비에서 확인합니다.</p>${row('연결 AI · 설치와 인증','제공자 연결·버전·지원 기능 확인','simulate:provider','settings')}</div>`;
  }
  function render(s) {
    if(s.id==='D15')return setup();
    if(s.id==='D17')return task();
    if(s.id==='D19')return compare();
    if(s.id==='D24')return integration();
    if(s.id==='D36')return provider();
    return null;
  }
  function mount(s) {
    if(s.id==='D16'){
      document.querySelector('.board')?.insertAdjacentHTML('afterbegin',`<section class="execution-board-note"><strong>분업 팀 · 단계별 검토</strong><p>대표 1 · 작업자 2 / 최대 3<br>검토자는 작업자 슬롯을 공유합니다.</p>${button('팀·모델 설정 보기','D15','small subtle')}<p>대기 T03: 저장 계약 미통합<br>검토 T02: 사용자 확인 필요</p></section>`);
    }
    if(['D05','M04'].includes(s.id))document.querySelector('.chat-top')?.insertAdjacentHTML('afterend',`<div class="execution-chat-role"><span>기획 담당 · 프로젝트 기본 모델</span>${button('지시 보기','simulate:role-planning','quiet small')}</div>`);
    if(s.id==='D20')document.querySelector('.review-doc .comparison')?.insertAdjacentHTML('afterend',`<div class="execution-review-note"><strong>독립 검토 · 결과 8d2b</strong><p>기준 설계 v1 · 작성자와 별도 세션 · 검토 대상 변경 시 만료</p>${button('검토 담당 지시','simulate:role-reviewer','small subtle')}</div>${evidence()}`);
    if(s.id==='M07')document.querySelector('.mobile-pad')?.insertAdjacentHTML('afterbegin',`<section class="execution-mobile-card"><strong>분업 팀 · 단계별 검토</strong><p>대표 1 + 작업자 2 · 전체 상한 4</p>${button('이번 실행의 설정','simulate:mobile-execution','small subtle')}</section>`);
    if(s.id==='M08')document.querySelector('.mobile-pad .segmented')?.insertAdjacentHTML('afterend',`<section class="execution-mobile-card"><strong>별도 검토 세션 · 결과 8d2b</strong><p>설계 v1과 비교 · 필수 검사 통과 예시<br>코드 변경 시 이 검토는 만료됩니다.</p>${button('적용 지시·모델','simulate:role-reviewer','small subtle')}${button('통합·출시 준비','simulate:mobile-integration','small quiet')}</section>`);
    if(s.id==='M15'){
      const old=document.querySelector('[data-target="simulate:provider"]');
      if(old){old.dataset.target='simulate:mobile-profile';old.querySelector('strong').textContent='AI 역할 · 다음 실행 설정';old.querySelector('small').textContent='PC 지원 모델 선택 · 설치와 인증은 PC에서';}
    }
    document.querySelector('#execution-mode')?.addEventListener('change',e=>{if(canInteract()){state.mode=e.target.value;refresh();document.querySelector('#execution-mode')?.focus();}});
    document.querySelector('#execution-policy')?.addEventListener('change',e=>{if(canInteract())state.policy=e.target.value;});
    document.querySelector('#execution-profile')?.addEventListener('change',e=>{if(canInteract()){state.profile=e.target.value;refresh();document.querySelector('#execution-profile')?.focus();}});
    if(s.id==='D36'){bindFields(document,state.profile);document.querySelector('#save-repair-limit')?.addEventListener('click',()=>{if(!canInteract())return;const input=document.querySelector('#repair-limit');const value=Number(input.value);const valid=input.value!==''&&Number.isSafeInteger(value)&&value>=0;document.querySelector('#repair-setting-status').textContent=valid?'새 작업에 적용할 재시도 횟수를 저장했습니다.':'0 이상의 정수를 입력하세요.';if(valid)state.repairLimit=value;});}
    document.querySelectorAll('[data-delivery-tab]').forEach(b=>b.addEventListener('click',()=>{
      if(!canInteract())return;
      state.tab=b.dataset.deliveryTab;
      const p=new URLSearchParams(location.hash.split('?')[1]||'');p.set('deliveryTab',state.tab);
      history.replaceState(null,'','#render/D24?'+p);refresh();
      document.querySelector(`[data-delivery-tab="${state.tab}"]`)?.focus();
    }));
  }
  function simulate(action) {
    if(action.startsWith('role-')){
      const id=action.slice(5), spec=specFor(id);if(!spec)return false;
      modal(roleName(id)+' · 지시와 모델 설정',fields(id));
      bindFields(document.querySelector('#dialog'),id);return true;
    }
    switch(action){
      case 'start-run':
        if(!isReady()){modal('설정을 먼저 확인하세요',readiness()+button('AI 역할 설정','D36','primary'));return true;}
        modal('실행 시작 체험',`<p>설계 v1 · ${modes.find(m=>m[0]===state.mode)[1]} · ${state.policy==='review'?'단계별 검토':'자율 진행'}</p><p>대상: T04 / T05 · 모델·지시 snapshot을 고정합니다.</p><div class="callout">로컬 통합과 검증 완료에서 종료합니다. 실제 AI나 셸을 실행하지 않는 예시입니다.</div>`,'예시 작업 화면 보기',()=>navigate({single:'D17',team:'D16',compare:'D19',review:'D20'}[state.mode]));return true;
      case 'retry-attempt':modal('새 시도로 재시도',`<p>실패한 시도 ${state.attempt}의 결과를 보존하고 새 시도를 만듭니다. 이전 완료 메시지는 새 결과를 덮어쓸 수 없습니다.</p>`,'새 시도 예시',()=>{state.attempt++;refresh();});return true;
      case 'adopt-A':state.selected='A';refresh();return true;
      case 'candidate-failed':modal('후보 B · 검증 부족',`<p>Android 입력 유지 검사 실패 예시. 원인과 로그를 보존합니다.</p><p>같은 기준 9c3a·같은 완료 조건으로 다시 요청해야 합니다.</p>`);return true;
      case 'evidence':case 'mobile-validation':modal('검증 근거 · 결과 8d2b',`<p>검사: 스킨 전환 중 입력 보존<br>명령: 프로젝트에 등록한 기능 검사<br>환경: Windows / Android · 버전·기기 포함<br>종료 코드: 0 · 예시<br>대상: 결과 8d2b · 설계 v1</p><p>실제 제품은 실행 시각·전체 명령·로그 위치·캡처를 함께 기록합니다. 미실행·실패를 통과로 표시하지 않습니다.</p>${button('작업으로 돌아가기',getScreen().platform==='android'?'M07':'D17','subtle')}`);return true;
      case 'stale-evidence':modal('결과가 변경되어 검토가 만료됨',`<p>기존 검토: 8d2b → 현재 결과: 9e3c</p><p>변경된 파일과 연결 조건을 다시 검사한 뒤 검토합니다. 이전 기록은 보존합니다.</p>${button('변경 확인','D22','primary')}`);return true;
      case 'release-evidence':modal('출시 준비 · 남은 확인',`<p>필수 미완료: 업데이트 실패 후 복구 실증<br>담당: 최종 검토·통합 담당<br>기준: 통합 c40e · Windows / Android</p><p>필요한 근거: 패키지 버전·해시·설치 로그, 구버전 데이터 복사본 이전 결과, 실패 후 백업 복원 결과.</p><p>통과 전에는 출시 준비 완료로 표시하지 않습니다.</p>`);return true;
      case 'integration-restore':modal('직전 성공 지점 유지',`<p>통합 후보 c40e는 실패 기록과 함께 격리합니다. 성공 기준 71ac와 사용자 작업은 보존합니다.</p><p>필요하면 성공 기준으로 별도 후보를 만들고 복구 검증을 수행합니다. 현재 작업 폴더를 reset하거나 덮어쓰지 않습니다.</p>`);return true;
      case 'mobile-integration':modal('로컬 통합과 출시 준비',`<p>기준: 설계 v1 · 통합 c40e<br>직전 성공: 71ac · 검토용 예시</p><h3>통합 후 검사</h3><p>Windows·Android 기능과 데이터 보존 통과 예시. 실패 시 후보를 격리하고 직전 성공 결과를 유지합니다.</p><h3>출시 준비</h3><p>Windows·Android 패키지 버전·해시·설치·이전 근거 확인</p><div class="callout warn">미완료 · 업데이트 실패 후 복구 실증이 남았습니다.</div><p>main 반영·외부 발행과 설치·실행 관리는 PC에서 확인합니다.</p>`);return true;
      case 'mobile-execution':modal('이번 실행의 설정',`<p>설계 v1 · 분업 팀 · 단계별 검토<br>다음 배정: 공통 계약 통합 후 시작</p>${receipt('coordinator')}${button('작업 담당의 지시 보기','simulate:role-builder','subtle')}<p>진행 중 시도의 설정은 고정되어 있습니다.</p>`);return true;
      case 'mobile-profile':modal('다음 실행 · 구현 담당',fields('builder'));bindFields(document.querySelector('#dialog'),'builder');return true;
      case 'task-detail':modal('T04 · 입력·산출물·담당',`<p>입력: 설계 v1 / T01 · 9c3a<br>산출물: 8d2b · diff · 검증 보고서<br>선행: 공통 계약 완료</p>${receipt()}<p>완료 보고 후 독립 검토를 기다립니다. 실패하면 새 시도로 재요청합니다.</p>${button('담당 AI','M04','subtle')}${button('검토 열기','M08','primary')}`);return true;
      default:return false;
    }
  }
  function portal() {
    shell(titleBlock('AFTER PLANNING','기획 이후, 완료까지의 흐름','각 단계의 입력·담당 AI·산출물·통과 조건과 실패 시 돌아갈 지점을 함께 봅니다.',`<a class="btn subtle" href="DELIVERY-DESIGN.md">설계 원문</a>`)+`<div class="callout">아래는 만들 제품의 사용 흐름입니다. EZTerminal 자체의 제작 순서는 제작 로드맵 G1–G8과 구현 인계 W01–W09에서 별도로 확인합니다.</div><div class="delivery-stage-links">${data.deliveryStages.map(s=>`<a href="#delivery?stage=${s.id}">${s.id} ${s.name}</a>`).join('')}</div>`+data.deliveryStages.map(s=>{
      const image=s.id==='L7'?'screens/flows/delivery-release.png':`screens/detail/${s.screen}.png`;
      return `<section class="delivery-stage" id="delivery-${s.id}"><div><span class="eyebrow">${s.id} · ${roleName(s.role)}</span><h2>${s.name}</h2><p>${s.action}</p><h3>입력</h3><ul>${s.inputs.map(x=>`<li>${x}</li>`).join('')}</ul><h3>완료하면 남는 것</h3><ul>${s.outputs.map(x=>`<li>${x}</li>`).join('')}</ul><p><strong>다음 조건</strong> · ${s.gate}</p><div class="callout warn"><strong>실패·복귀</strong><p>${s.failure}</p></div><p class="delivery-actions"><a href="#ai?profile=${s.role}" target="_blank" rel="noopener">역할 프롬프트</a> · <a href="#screen/${s.screen}" target="_blank" rel="noopener">Windows ${s.screen}</a> · <a href="#screen/${s.mobile}" target="_blank" rel="noopener">Android ${s.mobile}</a></p></div><a class="delivery-image" href="#render/${s.screen}?interactive=1${s.id==='L7'?'&deliveryTab=release':''}" target="_blank" rel="noopener"><img src="${image}" alt="${s.name} 예상 화면 ${s.screen}"><span>예상 화면 크게 보기 · 체험 ↗</span></a></section>`;
    }).join('')+`<section class="panel"><h2>설계 검토 후 구현 순서</h2><p>공통 계약 → Windows·Android 대화 → 기획 편집 → 화면 편집·AI 실행 → 검토·통합 → 기존 도구 연결 → 설치·이전·최종 검증</p><a class="text-link" href="#handoff">작업별 인계 보기 →</a></section>`,'delivery','기획 이후 단계',true);
    const id=new URLSearchParams(location.hash.split('?')[1]||'').get('stage');
    if(data.deliveryStages.some(s=>s.id===id))requestAnimationFrame(()=>document.querySelector('#delivery-'+id)?.scrollIntoView());
  }
  return {render,mount,simulate,portal};
};

