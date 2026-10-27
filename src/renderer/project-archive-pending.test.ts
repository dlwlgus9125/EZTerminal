import { describe, expect, it } from 'vitest';

import { projectArchivePendingStore } from './project-archive-pending';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: (key) => { map.delete(key); } };
}

describe('projectArchivePendingStore', () => {
  it('keeps one unanswered request per project and host until it is cleared', async () => {
    const storage = memoryStorage();
    const desktop = projectArchivePendingStore('desktop', storage);
    const phone = projectArchivePendingStore('phone:pc-1', storage);
    const request = { type: 'export', projectId: 'P', commandId: 'export-1' } as const;
    await desktop.write('P', request);
    expect(desktop.read('P')).toEqual(request);
    expect(phone.read('P')).toBeNull();
    expect(desktop.read('Q')).toBeNull();
    await desktop.write('P', null);
    expect(desktop.read('P')).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('drops an entry that is not a valid request or belongs to another project', () => {
    const storage = memoryStorage();
    const store = projectArchivePendingStore('desktop', storage);
    storage.setItem('ezterminal-project-archive-pending-v1:desktop:P', '{not json');
    expect(store.read('P')).toBeNull();
    storage.setItem('ezterminal-project-archive-pending-v1:desktop:P', JSON.stringify({ type: 'export', projectId: 'other', commandId: 'export-1' }));
    expect(store.read('P')).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});
