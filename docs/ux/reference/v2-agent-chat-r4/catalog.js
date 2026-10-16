// Authored fixtures for design review. None of these entries inspect or modify a host.
window.CHAT_REVIEW = {
  revision: 'r2',
  scenes: [
    ['welcome', '첫 메시지 전', 'Before the first message', '대화', 'Chat', '아무 메시지도 보내지 않고 스킬·모델·연결 상태를 확인합니다.', 'Inspect skills, models and connections without sending a message.'],
    ['loading', '기능 목록 준비 중', 'Preparing capabilities', '대화', 'Chat', '목록을 확인하는 동안 초안을 작성할 수 있습니다.', 'Keep drafting while capabilities are being loaded.'],
    ['skills', '명령·스킬 선택', 'Commands & skills', '대화', 'Chat', '/ 검색에서 설명·출처를 읽고 선택합니다. 선택만으로 실행하지 않습니다.', 'Search with /, read the source and choose. Selection does not execute.'],
    ['compose', '스킬·첨부와 첫 입력', 'Ready to send', '대화', 'Chat', '선택한 스킬과 참조가 첫 메시지에 포함됩니다.', 'Selected skills and references are included in the first message.'],
    ['streaming', '응답·도구 진행', 'Response & tool progress', '진행', 'In progress', '현재 동작과 완료한 도구 결과를 구분해 읽습니다.', 'Distinguish current activity from completed tool results.'],
    ['question', '사용자 질문', 'Question for you', '진행', 'In progress', '선택지 또는 직접 입력으로 질문에 답합니다.', 'Answer with an option or your own text.'],
    ['approval', '작업 승인', 'Action approval', '진행', 'In progress', '대상과 변경 내용을 읽고 허용하거나 거절합니다.', 'Review the target and effect, then allow or deny.'],
    ['queue', '후속 메시지 대기열', 'Follow-up queue', '진행', 'In progress', '대기 중 메시지를 편집·제거하거나 중단 후 보냅니다.', 'Edit or remove a queued message, or interrupt and send it.'],
    ['interrupted', '중단한 대화', 'Interrupted conversation', '복구', 'Recovery', '받은 내용과 초안을 유지하고 명시적으로 이어갑니다.', 'Keep the partial response and draft; continue explicitly.'],
    ['history', '이전 대화 다시 열기', 'Reopen a conversation', '복구', 'Recovery', '기록과 작업 위치를 확인하고 같은 대화에서 이어갑니다.', 'Inspect history and workspace, then continue the conversation.'],
    ['installed', '설치된 확장 기능', 'Installed extensions', '관리', 'Manage', '제공자·출처·적용 범위와 설치 상태를 확인합니다.', 'Inspect provider, source, scope and installation status.'],
    ['marketplace', '마켓 탐색', 'Browse marketplaces', '관리', 'Manage', '기존 제공자 마켓에서 확장을 찾고 설치 대상을 선택합니다.', 'Find extensions in provider marketplaces and choose the target.'],
    ['plugin', '플러그인 상세', 'Plugin details', '관리', 'Manage', '포함된 스킬·MCP와 업데이트·활성화·삭제 범위를 확인합니다.', 'Inspect included skills and MCP, update, enable or remove the package.'],
    ['install', '주소·폴더로 설치', 'Install from a source', '관리', 'Manage', 'Git 주소 또는 PC 폴더를 지정하고 설치 범위를 검토합니다.', 'Choose a Git source or a PC folder and review installation scope.'],
    ['install-failed', '설치 실패·재시도', 'Installation failed', '관리', 'Manage', '입력값과 기존 설치를 유지한 채 원인을 확인하고 재시도합니다.', 'Keep the source and existing installation, inspect the failure and retry.'],
    ['mcp', 'MCP 연결 관리', 'MCP connections', '관리', 'Manage', '실제 실행 호스트의 연결 상태와 서버 설정을 관리합니다.', 'Manage server settings and connections on the execution host.'],
    ['mcp-auth', 'PC에서 인증 필요', 'Host authentication needed', '복구', 'Recovery', '휴대전화에서 인증 위치를 확인하고 PC 인증 후 다시 조회합니다.', 'See where authentication happens, then recheck after signing in on the PC.'],
    ['mcp-failed', 'MCP 연결 실패', 'MCP connection failed', '복구', 'Recovery', '인증 필요와 연결 실패를 구분하고 재연결합니다.', 'Distinguish authentication from connection failure and retry.'],
    ['conflict', '설정 변경 충돌', 'Settings conflict', '복구', 'Recovery', '다른 앱의 변경을 덮어쓰지 않고 새 설정을 확인합니다.', 'Review changed settings without overwriting another app’s changes.'],
    ['restart', '새 대화부터 적용', 'Applies to the next chat', '복구', 'Recovery', '설치 완료와 현재 대화 적용 상태를 구분합니다.', 'Distinguish installed from active in the current conversation.'],
    ['offline', 'Android 오프라인', 'Android offline', '복구', 'Recovery', '기록·초안을 유지합니다. 재연결만으로 메시지를 보내지 않습니다.', 'Keep history and drafts. Reconnecting does not send messages.'],
    ['uncertain', '전송 결과 확인 중', 'Unconfirmed delivery', '복구', 'Recovery', '같은 메시지를 재전송하기 전에 PC 기록과 대조합니다.', 'Reconcile with the PC before retrying the same message.'],
    ['unavailable', '제공자 준비 필요', 'Provider setup needed', '복구', 'Recovery', '미지원과 인증 실패를 구분하고 다음 동작을 제공합니다.', 'Distinguish unsupported from authentication failure and show a next action.'],
    ['unsupported', '제공자 옵션 미지원', 'Unsupported provider option', '복구', 'Recovery', '미지원 옵션은 이유를 설명하고 지원되는 기본 대화는 유지합니다.', 'Explain unsupported options while keeping basic conversation available.'],
    ['empty', '설치된 스킬 없음', 'No installed skills', '대화', 'Chat', '빈 목록에서 설치 경로를 찾고 일반 메시지는 계속 작성합니다.', 'Find the install path from an empty list and continue drafting.']
  ].map(([id,ko,en,groupKo,groupEn,descKo,descEn])=>({id,name:[ko,en],group:[groupKo,groupEn],description:[descKo,descEn]})),
  providers: {
    codex: { label: 'Codex', model: 'GPT-6.1', models: ['GPT-6.1', 'GPT-6'], efforts: ['low','medium','high','xhigh'], prefix: '$' },
    claude: { label: 'Claude', model: 'Claude Sonnet 4.6', models: ['Claude Sonnet 4.6', 'Claude Opus 4.6'], efforts: ['low','medium','high'], prefix: '/' }
  },
  skills: [
    {id:'frontend',name:'frontend-design',token:'ezpowers:frontend-design',description:['화면 구조·상태·접근성을 함께 설계합니다.','Design screen structure, states and accessibility.'],source:'EZPowers',kind:'plugin',icon:'Layers'},
    {id:'diagnose',name:'diagnose',token:'ezpowers:diagnose',description:['문제를 재현하고 근거를 따라 원인을 좁힙니다.','Reproduce an issue and trace its cause with evidence.'],source:'EZPowers',kind:'plugin',icon:'Wrench'},
    {id:'interview',name:'deep-interview',token:'ezpowers:deep-interview',description:['중요한 질문으로 원하는 결과를 구체화합니다.','Clarify the intended outcome through focused questions.'],source:'EZPowers',kind:'plugin',icon:'MessageSquare'},
    {id:'review',name:'project-review',token:'project-review',description:['프로젝트의 변경 사항과 검증 근거를 검토합니다.','Review project changes and validation evidence.'],source:'.agents/skills',kind:'project',icon:'FileCode2'},
    {id:'docs',name:'docs-helper',token:'docs-helper',description:['프로젝트 문서의 구조와 표현을 정리합니다.','Improve the structure and wording of project docs.'],source:'Git · team/toolkit',kind:'user',icon:'FileText'}
  ],
  market: [
    {id:'ezpowers',name:'EZPowers',description:['기획부터 설계·구현·검증까지 함께하는 작업 스킬.','Workflow skills for planning, design, development and verification.'],tag:['작업 흐름','Workflow'],source:'ezpowers-dev',installed:true,icon:'Layers'},
    {id:'accessibility',name:'Accessibility toolkit',description:['키보드·명암 대비·보조 기술을 위한 UI 검토 스킬.','UI review skills for keyboard, contrast and assistive technology.'],tag:['디자인','Design'],source:'team-marketplace',installed:false,icon:'ShieldCheck'},
    {id:'repo-notes',name:'Repository notes',description:['저장소 탐색과 변경 기록을 돕는 문서 스킬.','Documentation skills for repository exploration and change notes.'],tag:['문서','Documentation'],source:'team-marketplace',installed:false,icon:'FileText'}
  ],
  servers: [
    {id:'docs',name:'Documentation',description:['공식 문서 검색과 참조','Search and reference documentation'],transport:'HTTP',address:'https://docs.example.com/mcp',status:'connected',tools:4},
    {id:'project',name:'Project tools',description:['현재 작업공간의 파일과 작업 도구','Files and task tools for this workspace'],transport:'stdio',address:'node ./tools/project-mcp.mjs',status:'connected',tools:6},
    {id:'design',name:'Design library',description:['팀의 디자인 자료와 컴포넌트','Team design assets and components'],transport:'HTTP',address:'https://design.example.com/mcp',status:'needs-auth',tools:0}
  ]
};
