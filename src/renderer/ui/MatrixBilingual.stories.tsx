import { Play, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  PanelShell,
  Status,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from './index';

const meta = {
  title: 'Compositions/Matrix bilingual workbench',
  component: PanelShell,
  parameters: {
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
  args: {
    title: 'Panel',
  },
} satisfies Meta<typeof PanelShell>;

export default meta;
type Story = StoryObj<typeof meta>;

const COPY = {
  en: {
    title: 'Terminal workbench',
    description: 'PowerShell · local session',
    newPane: 'New pane',
    search: 'Search output',
    connected: 'Connected',
    general: 'Terminal',
    automation: 'Automation',
    command: 'Command',
    placeholder: 'Enter a command',
    run: 'Run',
    confirm: 'Confirm risky pane close',
    output: 'PS C:\\Workspace> git status\nOn branch main\nYour branch is up to date.',
    ready: 'Ready for input',
  },
  ko: {
    title: '터미널 워크벤치',
    description: 'PowerShell · 로컬 세션',
    newPane: '새 패널',
    search: '출력 검색',
    connected: '연결됨',
    general: '터미널',
    automation: '자동화',
    command: '명령어',
    placeholder: '명령어를 입력하세요',
    run: '실행',
    confirm: '위험한 패널 닫기 전 확인',
    output: 'PS C:\\작업공간> git status\n현재 브랜치: main\n원격 브랜치와 같은 상태입니다.',
    ready: '입력 대기 중',
  },
} as const;

function WorkbenchSample({ locale }: { readonly locale: keyof typeof COPY }): JSX.Element {
  const copy = COPY[locale];
  const [tab, setTab] = useState('terminal');
  const [confirmClose, setConfirmClose] = useState(true);
  return (
    <main className="ez-story-composition" data-theme="matrix" lang={locale}>
      <PanelShell
        title={copy.title}
        description={copy.description}
        actions={
          <div className="ez-story-composition__toolbar">
            <Status variant="success">{copy.connected}</Status>
            <IconButton icon={Search} aria-label={copy.search} />
            <Button size="sm" leadingIcon={<Plus />}>{copy.newPane}</Button>
          </div>
        }
        footer={
          <div className="ez-story-composition__toolbar">
            <Badge variant="accent">MATRIX / CRT</Badge>
            <Status variant="success" live="polite">{copy.ready}</Status>
          </div>
        }
      >
        <Tabs value={tab} onValueChange={setTab}>
          <TabList label={locale === 'ko' ? '워크벤치 섹션' : 'Workbench sections'}>
            <Tab value="terminal">{copy.general}</Tab>
            <Tab value="automation">{copy.automation}</Tab>
          </TabList>
          <TabPanel value="terminal">
            <div className="ez-story-stack" style={{ inlineSize: 'auto' }}>
              <pre className="ez-story-terminal-preview">{copy.output}</pre>
              <form
                className="ez-story-row"
                style={{ inlineSize: '100%' }}
                onSubmit={(event) => event.preventDefault()}
              >
                <Field label={copy.command} labelHidden style={{ flex: '1 1 18rem' }}>
                  <Input placeholder={copy.placeholder} />
                </Field>
                <Button type="submit" variant="primary" leadingIcon={<Play />}>{copy.run}</Button>
              </form>
            </div>
          </TabPanel>
          <TabPanel value="automation">
            <Switch
              label={copy.confirm}
              checked={confirmClose}
              onChange={(event) => setConfirmClose(event.currentTarget.checked)}
            />
          </TabPanel>
        </Tabs>
      </PanelShell>
    </main>
  );
}

export const English: Story = {
  render: () => <WorkbenchSample locale="en" />,
  globals: {
    theme: 'matrix',
    locale: 'en',
  },
};

export const Korean: Story = {
  render: () => <WorkbenchSample locale="ko" />,
  globals: {
    theme: 'matrix',
    locale: 'ko',
  },
};
