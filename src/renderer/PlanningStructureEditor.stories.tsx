import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { PlanningSnapshot } from '../shared/planning';
import { AppI18nProvider } from './i18n';
import { PlanningStructureEditor } from './PlanningStructureEditor';
import { planningExecutionFixture } from './planning-execution-fixtures';
import './index.css';
import './planning-workspace.css';
const base = planningExecutionFixture().planning;
const snapshot: PlanningSnapshot = {...base, draft: {...base.draft, items: [
  {id:'home',revision:1,kind:'information',title:'프로젝트 홈',body:'프로젝트의 다음 행동과 진행 상태를 확인한다.',acceptance:[],status:'ready'},
  {id:'planning',revision:1,kind:'information',title:'기획과 화면 설계',body:'',acceptance:[],status:'ready'},
  {id:'chat',revision:1,kind:'information',title:'프로젝트 대화',body:'',acceptance:[],status:'draft'},
  {id:'tasks',revision:1,kind:'information',title:'작업 실행과 검토',body:'',acceptance:[],status:'draft'},
  {id:'submit',revision:1,kind:'flow',flowStep:{kind:'action'},title:'사용자가 첫 메시지를 전송한다',body:'',acceptance:[],status:'ready'},
  {id:'connection',revision:1,kind:'flow',flowStep:{kind:'condition'},title:'PC 연결 상태를 확인한다',body:'',acceptance:[],status:'ready'},
  {id:'sent',revision:1,kind:'flow',flowStep:{kind:'end'},title:'메시지 전송 완료',body:'',acceptance:[],status:'ready'},
  {id:'retained',revision:1,kind:'flow',flowStep:{kind:'end'},title:'초안 보존 후 다시 연결',body:'',acceptance:[],status:'review-needed'},
], links:[
  ...['planning','chat','tasks'].map((id) => ({id:`contains-${id}`,revision:1,kind:'contains' as const,fromId:'home',toId:id,note:''})),
  {id:'start-connection',revision:1,kind:'navigates-to',fromId:'submit',toId:'connection',note:'전송 버튼'},
  {id:'connection-success',revision:1,kind:'navigates-to',fromId:'connection',toId:'sent',note:'PC 연결됨'},
  {id:'connection-offline',revision:1,kind:'navigates-to',fromId:'connection',toId:'retained',note:'오프라인 또는 연결 실패'},
]}};
const meta: Meta<typeof PlanningStructureEditor> = {title:'Production/Planning/Structure and flow',component:PlanningStructureEditor,parameters:{layout:'fullscreen'},args:{mode:'information',snapshot,disabled:false,onPatch:fn(),onEditItem:fn(),onOpenDesign:fn()},decorators:[(Story)=><AppI18nProvider locale="ko" languages={['ko']}><div className="planning-workspace" style={{height:'100vh'}}><Story /></div></AppI18nProvider>]};
export default meta;
type Story = StoryObj<typeof meta>;
export const Information: Story = {};
export const UserFlow: Story = {args:{mode:'flow'}};
export const MobileFlow: Story = {args:{mode:'flow'},decorators:[(Story)=><div style={{width:'min(390px, 100vw)'}}><Story /></div>]};
