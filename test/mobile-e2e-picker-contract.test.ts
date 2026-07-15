import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findDocumentsUiFileResult,
  findDocumentsUiSearchAction,
  findDocumentsUiSearchField,
  isPublishedEzTerminalMediaStoreDownload,
  parseMediaStoreDownloadUri,
  parseEzTerminalMediaStoreDownloadIds,
  type DumpNode,
} from '../mobile/e2e/lib.ts';

function node(overrides: Partial<DumpNode>): DumpNode {
  return {
    text: '',
    desc: '',
    resourceId: '',
    packageName: 'com.android.documentsui',
    className: 'android.widget.TextView',
    clickable: false,
    bounds: [0, 0, 100, 50],
    ...overrides,
  };
}

describe('DocumentsUI picker selectors', () => {
  it('selects a file title instead of the same-text API 35 search field', () => {
    const filename = 'parityread123';
    const searchField = node({
      text: filename,
      resourceId: 'com.google.android.documentsui:id/search_src_text',
      packageName: 'com.google.android.documentsui',
      className: 'android.widget.AutoCompleteTextView',
      bounds: [50, 20, 700, 100],
    });
    const result = node({
      text: filename,
      resourceId: 'android:id/title',
      packageName: 'com.google.android.documentsui',
      bounds: [80, 180, 500, 250],
    });

    expect(findDocumentsUiSearchField([searchField, result])).toBe(searchField);
    expect(findDocumentsUiFileResult([searchField, result], filename)).toBe(result);
  });

  it('accepts the API 29 EditText field and stable search action id', () => {
    const action = node({
      resourceId: 'com.android.documentsui:id/option_menu_search',
      className: 'android.widget.ImageButton',
      clickable: true,
    });
    const field = node({
      resourceId: 'com.android.documentsui:id/search_src_text',
      className: 'android.widget.EditText',
    });

    expect(findDocumentsUiSearchAction([action, field])).toBe(action);
    expect(findDocumentsUiSearchField([action, field])).toBe(field);
  });

  it('extracts only exact MediaStore Downloads item URIs from telemetry', () => {
    expect(parseMediaStoreDownloadUri(
      '[ez-e2e] files:download-done report 25 content://media/external_primary/downloads/42',
    )).toBe('content://media/external_primary/downloads/42');
    expect(parseMediaStoreDownloadUri(
      '[ez-e2e] files:download-done report 25 content://media/external/downloads/7',
    )).toBe('content://media/external/downloads/7');
    expect(parseMediaStoreDownloadUri('content://other.provider/documents/42')).toBeNull();
  });

  it('parses API 29/35 MediaStore field order, trailing slash, and CRLF variants', () => {
    const name = 'parityread123';
    const api35 = `Row: 0 _id=1000000035, _display_name=${name}, relative_path=Download/EZTerminal/, is_pending=0\r\n`;
    const api29 = `Row: 0 relative_path=Download/EZTerminal, _display_name=${name}, _id=42\r\n`;

    expect(parseEzTerminalMediaStoreDownloadIds(api35, name)).toEqual(['1000000035']);
    expect(parseEzTerminalMediaStoreDownloadIds(api29, name)).toEqual(['42']);
    expect(isPublishedEzTerminalMediaStoreDownload(api35, name)).toBe(true);
    expect(isPublishedEzTerminalMediaStoreDownload(api35, `${name}0`)).toBe(false);
  });

  it('keeps text MIME while injecting only an alphanumeric picker query', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../mobile/e2e/parity.ts'),
      'utf8',
    );

    expect(source).toContain('const query = path.parse(filename).name');
    expect(source).toContain('await typeText(query)');
    expect(source).toContain('`parityread${Date.now()}.txt`');
  });
});
