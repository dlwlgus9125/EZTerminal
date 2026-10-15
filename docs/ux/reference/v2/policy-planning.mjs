// Confirmed interview choices. Design reference only; no runtime commands.
export const policyConfirmation = { date:'2026-10-13', status:'confirmed', source:'deep-interview 최종 요약에 대한 사용자 1번 선택', scope:'11개 운영 정책', designApproved:false, implementationApproved:false };
export const policies = [
  {id:'I01',name:'요구사항 변경',rule:'영향 작업과 후속 의존 작업만 멈추고 변경 계획·재작업 범위를 확인받아 재개한다. 무관한 작업과 이전 기준·결과는 유지한다.',screens:['D13','D15','D16','D17','M07','M08'],owners:['W01','W04','W06','W07'],acceptance:'T04 변경 시 T04·의존 T06만 보류하고 무관한 T09는 계속한다. 새 기준 승인 전 재배정하지 않는다.'},
  {id:'I02',name:'빠른 작업 시작',rule:'목표·대상·범위·완료 조건을 담은 요약 카드에서 사용자가 실행한다. 전체 PRD는 요구하지 않는다.',screens:['D18','M04'],owners:['W02','W03','W06'],acceptance:'요청 입력과 카드 생성만으로 파일을 바꾸지 않는다. 실행 후 taskId·receipt가 붙으며 중복 클릭은 같은 결과를 가리킨다.'},
  {id:'I03',name:'검증 실패 재시도',rule:'최초 검증 실패 후 기본 최대 2회 추가 수정·재검증한다. 횟수는 설정 가능하며 소진 시 시도와 남은 문제를 보존하고 사용자 판단을 기다린다.',screens:['D15','D17','D36','M07','M15'],owners:['W01','W06','W07'],acceptance:'기본값에서 최초 시도+추가 2회 이후 자동으로 네 번째 시도를 만들지 않는다. 재시작으로 횟수를 초기화하지 않는다.'},
  {id:'I04',name:'프로필 편집',rule:'모델·추론·지시문·참조 문맥·허용 도구를 직접 편집하고 저장·버전·되돌리기를 제공한다. AI도 수정안을 만들 수 있다. 상위 권한은 유지한다.',screens:['D15','D36','M15'],owners:['W01','W06'],acceptance:'8개 역할을 편집할 수 있고, 기획 프로필에 코드 실행 권한을 추가해도 상위 정책을 넘지 못한다.'},
  {id:'I05',name:'AI 프로필 수정 적용',rule:'AI는 변경 전후와 이유를 제시한다. 사용자 적용 후 새 버전으로 저장하며 진행 중 시도는 고정된 설정을 유지한다.',screens:['D36','D17','M15'],owners:['W01','W06'],acceptance:'제안·취소는 저장 버전을 바꾸지 않는다. v2 적용 후에도 실행 중 시도는 v1이고 새 실행만 v2를 사용한다.'},
  {id:'I06',name:'전체 기록 백업',rule:'기획·화면·확정본·역할 프로필·검토 기록과 대화 원문·실행 로그·캡처까지 기본 포함한다. 인증 정보는 제외하고 다른 PC에서 연결을 다시 확인한다.',screens:['D25','D44'],owners:['W01','W08','W09'],acceptance:'다른 PC의 임시 프로젝트에 복원해 항목·참조·기록·캡처 해시를 대조한다. 인증·프로세스·실행 권한을 복원해 자동 실행하지 않는다.'},
  {id:'I07',name:'Android 오프라인',rule:'최근 동기화 내용 열람과 메시지 초안 작성을 허용한다. 마지막 동기화 시점을 표시하며 재연결 후 사용자가 확인해 전송한다.',screens:['M04','M05','M07','M16'],owners:['W01','W03'],acceptance:'오프라인 초안은 앱 재시작 후에도 남고 재연결만으로 전송되지 않는다. 이미 보낸 미확정 명령과 미전송 초안을 구분한다.'},
  {id:'I08',name:'기록 보관',rule:'전체 기록을 자동 삭제하지 않는다. 저장 용량을 보여 주고 사용자가 프로젝트별로 직접 정리한다.',screens:['D25','D38','M15'],owners:['W01','W08'],acceptance:'기간 경과·용량 부족만으로 기록을 지우지 않는다. 삭제 전 대상·참조 영향을 보이고 활성 실행·확정본 필수 자료는 보호한다.'},
  {id:'I09',name:'전체 실행 시간',rule:'전체 실행 시간 제한 없이 다음 검토·승인 지점까지 진행한다. 수동 중단과 검증 실패 재시도 제한은 유지한다.',screens:['D15','D17','M07'],owners:['W06'],acceptance:'경과 시간만으로 실행을 종료하지 않는다. 취소·연결 장애·개별 도구 실패·검토 대기를 무제한 반복 허용으로 해석하지 않는다.'},
  {id:'I10',name:'공통 UI 요소',rule:'반복 요소를 공통 원본에 연결하고 화면별 예외를 허용한다. 공통 변경은 연결된 초안에 반영하며 승인된 확정본은 유지한다.',screens:['D10','D12','M06'],owners:['W01','W05'],acceptance:'공통 카드 변경은 연결된 초안에만 반영된다. 지정한 예외와 확정본은 보존되며 변경 묶음을 되돌릴 수 있다.'},
  {id:'I11',name:'AI 연결·사용량 장애',rule:'해당 작업을 대기시키고 중단 이유와 대체 AI 선택지를 보여 준다. 임의로 전환하지 않으며 독립 작업은 계속한다.',screens:['D17','D27','D36','M07','M08'],owners:['W01','W06'],acceptance:'장애만으로 다른 제공자를 호출하지 않는다. 실행 여부가 불명확하면 대조 후 사용자 선택으로 새 시도를 만들고 설정·인계 내용을 기록한다.'},
];
const scene=(screen,variant,title,action,result)=>({screen,variant,title,action,result,image:`screens/policies/${variant}.png`,wireframe:`screens/policies/${variant}-wireframe.png`});
export const policyFlows = [
 {id:'PF01',name:'빠른 작업의 명시적 시작',policies:['I02'],scenes:[scene('D18','quick-ready','요약 카드 확인','요청의 목표·범위·완료 조건을 확인하거나 수정합니다.','실행 전 상태로 남습니다.'),scene('D18','quick-running','실행 후 작업 추적','실행 버튼을 누릅니다.','작업 ID와 시작 기록이 표시됩니다. 같은 요청을 중복 실행하지 않습니다.')]},
 {id:'PF02',name:'진행 중 설계 변경',policies:['I01'],scenes:[scene('D16','replan-impact','영향 범위와 변경 계획','영향 작업·후속 작업·무관한 작업 및 재작업을 검토합니다.','T04·T06만 보류하며 T09는 계속합니다.'),scene('D16','replan-approved','새 기준으로 재개','정확한 변경 계획과 새 기준을 확인해 적용합니다.','이전 시도는 보존하고 새 기준의 시도를 배정합니다.')]},
 {id:'PF03',name:'검증 실패와 사용자 판단',policies:['I03','I09'],scenes:[scene('D17','retry-active','추가 수정과 검증','실패 근거·사용한 재시도·남은 횟수를 봅니다.','최초 실패 이후 추가 1/2회가 진행됩니다.'),scene('D17','retry-exhausted','재시도 소진','각 시도의 결과와 남은 문제를 확인합니다.','추가 2/2회 이후 대기합니다. 시간 경과로 종료하거나 자동 3회째 재시도하지 않습니다.')]},
 {id:'PF04',name:'AI와 역할 프로필 개선',policies:['I04','I05'],scenes:[scene('D36','profile-edit','직접 편집 또는 AI 수정 요청','모델·지시문·문맥·도구를 조정하거나 개선을 요청합니다.','요청만으로 저장 버전은 바뀌지 않습니다.'),scene('D36','profile-proposal','변경 전후와 이유 확인','AI 제안의 변경 범위와 상위 권한 제한을 확인합니다.','적용 전 제안으로 남으며 취소할 수 있습니다.'),scene('D36','profile-applied','새 버전 저장','적용 버튼을 누릅니다.','새 실행은 v2, 진행 중 시도는 v1을 유지합니다. 이전 버전으로 되돌릴 수 있습니다.')]},
 {id:'PF05',name:'AI 장애 후 사용자 선택',policies:['I11'],scenes:[scene('D17','provider-wait','해당 작업 대기','사용량 한도 또는 연결 장애 이유와 마지막 확인을 봅니다.','독립 작업은 진행하고 대체 AI는 아직 호출하지 않습니다.'),scene('D17','provider-choice','대체 AI와 인계 확인','사용 가능한 AI를 선택하고 인계 내용을 확인합니다.','결과 대조가 끝난 작업만 새 시도로 이어갈 수 있습니다.')]},
 {id:'PF06',name:'백업·다른 PC 복원·용량 관리',policies:['I06','I08'],scenes:[scene('D25','backup','전체 기록 포함 확인','원본·대화·상세 로그·캡처와 용량을 확인합니다.','인증 정보를 제외한 일관된 snapshot을 만듭니다.'),scene('D44','restore','새 PC에서 복원 검토','무결성·경로 연결·사용 가능한 AI를 확인합니다.','원본을 덮어쓰지 않고 복원하며 실행은 별도 시작합니다.'),scene('D38','retention','기록 직접 정리','프로젝트별 용량과 선택한 삭제 대상을 확인합니다.','자동 삭제하지 않습니다. 활성 실행·필수 참조는 삭제 대상에서 제외합니다.')]},
 {id:'PF07',name:'Android 연결 단절과 초안',policies:['I07'],scenes:[scene('M04','offline-draft','저장된 내용과 초안','마지막 동기화 시각을 보고 메시지 초안을 작성합니다.','초안을 기기에 보관하며 AI·터미널 명령을 보내지 않습니다.'),scene('M04','reconnected-draft','재연결 후 직접 전송','PC·세션·최신 상태를 확인한 뒤 보내기를 누릅니다.','재연결만으로 전송되지 않습니다. 이미 보낸 요청은 먼저 PC 기록과 대조합니다.')]},
 {id:'PF08',name:'공통 요소와 화면별 예외',policies:['I10'],scenes:[scene('D10','component','연결된 화면 확인','공통 카드의 상태와 초안 인스턴스·예외를 확인합니다.','같은 원본을 사용하는 화면과 변경 범위를 식별합니다.'),scene('D10','component-updated','공통 변경 결과','공통 요소를 수정합니다.','연결 초안 2개가 갱신되고 지정한 예외와 확정본 v1은 유지됩니다.')]},
];

export function applyConfirmedPolicies(c) {
 const changed=['D10','D12','D13','D15','D16','D17','D18','D25','D27','D36','D38','D44','M04','M05','M06','M07','M08','M15','M16'];
 Object.assign(c.meta,{date:'2026-10-13',revision:4,revisionLabel:'확정 정책·변경·복구 흐름',changedScreens:changed,policyConfirmation});
 for(const id of changed)c.meta.screenRevisions[id]=4;
 c.decisions.push(...policies.map(p=>[p.id,p.name,p.rule]));
 for(const p of policies)for(const id of p.screens){const s=c.screens.find(s=>s.id===id);s.policyIds=[...(s.policyIds||[]),p.id];s.acceptance.push(p.acceptance);}
 const screen=id=>c.screens.find(s=>s.id===id);
 screen('D25').goal='전체 작업 기록을 백업하고 다른 PC로 옮길 패키지를 준비한다.';
 screen('D25').parts=['백업·공유 목적','전체 기록·용량','인증 제외·민감 내용 확인','무결성·복원 안내'];
 screen('D25').actions=[{label:'전체 기록 백업',target:'simulate:policy-backup'},{label:'복원 확인',target:'D44'}];
 screen('D36').parts=['역할·설정 초안','모델·추론·지시문·문맥·도구 편집','AI 수정 제안·비교·적용','버전·되돌리기','설치·인증'];
 screen('D36').states.proposal='AI 수정 제안: 변경 전후와 이유를 확인하고 적용해야 새 버전이 저장됩니다.';
 screen('D16').states.replan='요구사항 변경: 영향받는 T04와 의존 T06만 보류합니다. 무관한 T09는 계속 진행합니다.';
 screen('D17').states.exhausted='최초 실패와 추가 수정·재검증 2회 기록을 보존했습니다. 사용자 판단을 기다립니다.';
 screen('D17').states.provider='담당 AI를 사용할 수 없습니다. 해당 작업은 대기하고 사용자가 대체 AI를 선택합니다.';
 screen('M04').states.offline='마지막 동기화 시점을 표시합니다. 저장된 대화 열람과 메시지 초안 작성만 가능하며 자동 전송하지 않습니다.';
 screen('M05').states.offline='최근 동기화한 문서를 읽기 전용으로 표시합니다. 저장된 내용이 없으면 미동기화로 안내합니다.';
 screen('M07').states.offline='마지막 확인한 작업 상태입니다. PC 최신 상태를 추정하지 않으며 실행·승인은 재연결 후 가능합니다.';
 screen('M16').acceptance.push('이미 전송한 미확정 요청은 PC 기록으로 대조하고, 미전송 초안은 사용자가 별도로 전송한다.');
 const feature=id=>c.features.find(f=>f.id===id);
 feature('F08').acceptance.push(...policies.filter(p=>['I01','I03','I04','I05','I09','I11'].includes(p.id)).map(p=>p.rule));
 feature('F13').behavior='전체 프로젝트 백업은 원본·대화·로그·캡처를 기본 포함하며 인증은 제외한다. 외부 공유용 문서 내보내기는 목적과 포함 항목을 별도로 확인한다.';
 feature('F13').acceptance.push(policies[5].acceptance,policies[7].acceptance);
 feature('F02').acceptance.push(policies[1].rule,policies[6].rule);
 feature('F06').acceptance.push(policies[9].rule);
 const quick=c.journeys.find(j=>j.id==='U03');
 quick.steps.splice(2,0,'D18');
 quick.scenes[1]={...quick.scenes[1],title:'요청과 실행 요약 카드 확인하기',action:'스킨을 전환해도 유지되는 대화에서 목표·대상·범위·완료 조건을 확인합니다.',result:'실행 전 요약 카드가 나타납니다. 실제 수정은 시작하지 않았습니다.',next:'카드에서 실행을 누릅니다.',variant:'quick-ready',ai:{profileId:'general',mode:'request'}};
 quick.scenes.splice(2,0,{screen:'D18',title:'실행을 시작하고 작업 추적하기',action:'검토한 요약 카드의 실행을 누릅니다.',result:'같은 대화에 작업 ID와 실행 기록이 연결됩니다.',next:'작업 결과를 파일에서 검토합니다.',variant:'quick-running',ai:{profileId:'builder',mode:'observe'}});
 quick.recovery.resume=4;
 quick.scenes.forEach((s,i)=>s.key=`U03-${i+1}`);
 const change=c.journeys.find(j=>j.id==='U08');
 change.steps.splice(3,0,'D16');
 change.scenes.splice(3,0,{screen:'D16',title:'변경 계획과 영향 작업 확인하기',action:'영향 작업·후속 의존 작업·재작업 범위를 확인합니다.',result:'T04·T06만 보류하며 무관한 작업은 계속합니다. 이전 결과는 보존합니다.',next:'화면과 변경 계획을 검토한 뒤 새 기준을 적용합니다.',variant:'replan-impact',ai:{profileId:'coordinator',mode:'request'}});
 Object.assign(change.scenes.at(-1),{title:'확인한 변경 계획으로 재개하기',action:'새 기준·재작업·선행조건을 확인해 변경 계획을 적용합니다.',result:'영향 작업만 새 기준의 시도로 이어집니다. 이전 시도·결과는 변경하지 않습니다.',next:'배정과 검토 지점은 선택한 진행 정책을 따릅니다.'});
 change.success='영향 작업과 후속 의존 작업만 확인받은 새 기준으로 재개하고 무관한 작업은 유지한다.';
 change.recovery.resume=6;change.scenes.forEach((s,i)=>s.key=`U08-${i+1}`);
 const retry=c.journeys.find(j=>j.id==='U02').recovery;
 Object.assign(retry,{state:'exhausted',title:'추가 수정·재검증 소진 후 사용자 판단',action:'최초 실패와 추가 2회 결과·남은 문제를 확인합니다.',result:'자동 재시도를 멈추고 사용자의 수정 지시·추가 시도·취소 선택을 기다립니다.'});
 for(const flow of c.journeys)for(const s of flow.scenes)if(s.variant){s.image=`screens/policies/${s.variant}.png`;s.wireframe=`screens/policies/${s.variant}-wireframe.png`;}
 for(const w of c.handoffs){const ps=policies.filter(p=>p.owners.includes(w.id));w.policyIds=ps.map(p=>p.id);w.checks.push(...ps.map(p=>`${p.id}: ${p.acceptance}`));w.contract.validation+=' 확정 정책: '+ps.map(p=>`${p.id} ${p.name}`).join(', ');}
 c.handoffs.find(w=>w.id==='W01').owns.push('Task·Session·Turn 연결, 변경 계획, 환경 lease, 백업·초안·컴포넌트 버전 계약');
 c.handoffs.find(w=>w.id==='W05').checks.push('공통 요소·예외·자산·반응형·상태·참조 export/import 왕복');
 c.handoffs.find(w=>w.id==='W06').checks.push('참여 역할만 준비 검사','포트·서버·테스트 데이터 격리 및 소유 프로세스만 종료');
 c.handoffs.find(w=>w.id==='W08').checks.push('인증 제외·전체 기록 백업 복원','수동 정리와 디스크 부족 중 원본 보존');
 for(const phase of c.roadmap)if(phase.id==='P6')phase.gate='11개 정책 확정 완료. r4 전체 화면·흐름에 대한 사용자 검토와 의견 해결은 별도';
 c.deliveryStages.find(s=>s.id==='L1').gate='선택한 운영 방식의 참여 역할·참조·권한이 유효하고 사용자가 실행을 시작해야 합니다. 전체 시간 제한 없음, 검증 실패 추가 재시도 기본 2회.';
 c.deliveryStages.find(s=>s.id==='L3').failure='검증 실패는 기본 2회 추가 수정·재검증 후 대기합니다. AI 연결·사용량 장애는 해당 작업을 보류하고 대체 AI 선택을 요청합니다. 불명확한 실행은 먼저 대조합니다.';
 c.deliveryStages.find(s=>s.id==='L5').failure='검증 실패는 남은 재시도 내 L3으로 복귀합니다. 요구사항 변경은 영향 작업과 후속 의존 작업만 멈추고 새 초안·변경 계획 확인 후 재개합니다. 이전 검토와 근거는 보존합니다.';
}
