/* Vite's `?worker` transform supplies these default constructor exports after
   the static import resolver has inspected the underlying worker modules. */
/* eslint-disable import/default, import/no-named-as-default */
import * as monaco from 'monaco-editor';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

interface MonacoEnvironmentShape {
  getWorker(moduleId: string, label: string): Worker;
}

const target = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironmentShape };
if (!target.MonacoEnvironment) {
  target.MonacoEnvironment = {
    getWorker: (_moduleId, label) => {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
      return new EditorWorker();
    },
  };
}

export { monaco };
