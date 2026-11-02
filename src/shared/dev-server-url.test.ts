import { describe, expect, it } from 'vitest';

import { DevUrlScanner, findDevUrls } from './dev-server-url';

describe('findDevUrls: the local addresses a text names', () => {
  it.each([
    ['  ➜  Local:   http://localhost:5173/\n', ['http://localhost:5173/']],
    ['Server listening at http://127.0.0.1:8000/docs', ['http://127.0.0.1:8000/docs']],
    ['ready on http://[::1]:3000', ['http://[::1]:3000/']],
    ['app at https://shop.localhost:8443/cart?x=1', ['https://shop.localhost:8443/cart?x=1']],
    ['   - Local:        http://localhost:3000\n   - Network:      http://192.168.0.7:3000\n', ['http://localhost:3000/']],
  ])('finds them in %j', (text, urls) => {
    expect(findDevUrls(text)).toEqual(urls);
  });

  it('reads through colour, which a dev server puts inside the address', () => {
    expect(findDevUrls('Local: \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m')).toEqual(['http://localhost:5173/']);
  });

  it('takes 0.0.0.0, which listens everywhere, as this PC', () => {
    expect(findDevUrls('Running on http://0.0.0.0:8080/ (Press CTRL+C to quit)')).toEqual(['http://localhost:8080/']);
  });

  it('leaves off what ends a sentence', () => {
    expect(findDevUrls('Open http://localhost:5173/, or (http://localhost:4173/).')).toEqual(['http://localhost:5173/', 'http://localhost:4173/']);
  });

  it('says each one once', () => {
    expect(findDevUrls('http://localhost:5173/ and http://localhost:5173/ again')).toEqual(['http://localhost:5173/']);
  });

  it.each(['https://example.com/', 'http://localhost.evil.example:5173/', 'http://192.168.0.7:3000/', 'http://user:pass@localhost:5173/', 'ftp://localhost/', 'localhost:5173 alone'])('takes nothing from %s', (text) => {
    expect(findDevUrls(text)).toEqual([]);
  });

  it('never offers the app\'s own ports', () => {
    expect(findDevUrls('http://localhost:4100/mcp and http://localhost:5173/', new Set([4100]))).toEqual(['http://localhost:5173/']);
  });
});

describe('DevUrlScanner: a terminal, a chunk at a time', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('finds an address split across chunks, a colour code too', () => {
    const scanner = new DevUrlScanner();
    expect(scanner.feed(encode('Local: http://local'))).toEqual([]);
    expect(scanner.feed(encode('host:\u001b[1m51'))).toEqual([]);
    expect(scanner.feed(encode('73\u001b[22m/\r\n'))).toEqual(['http://localhost:5173/']);
  });

  it('says an address once, however often the server prints it', () => {
    const scanner = new DevUrlScanner();
    expect(scanner.feed(encode('http://localhost:5173/\n'))).toEqual(['http://localhost:5173/']);
    expect(scanner.feed(encode('http://localhost:5173/\n'))).toEqual([]);
    expect(scanner.feed(encode('restarted http://localhost:5174/\n'))).toEqual(['http://localhost:5174/']);
  });

  it('survives a character split across chunks', () => {
    const scanner = new DevUrlScanner();
    const bytes = encode('➜ http://localhost:5173/\n');
    expect([...scanner.feed(bytes.slice(0, 2)), ...scanner.feed(bytes.slice(2))]).toEqual(['http://localhost:5173/']);
  });

  it('remembers a bounded number, and keeps little of what it read', () => {
    const scanner = new DevUrlScanner();
    for (let port = 1; port <= 300; port += 1) scanner.feed(encode(`http://localhost:${String(port)}/\n`));
    expect(scanner.feed(encode('http://localhost:300/\n')), 'the latest are remembered').toEqual([]);
    expect(scanner.feed(encode('http://localhost:1/\n')), 'the oldest may come again').toEqual(['http://localhost:1/']);
    expect(scanner.feed(encode('x'.repeat(1_000_000)))).toEqual([]);
  });

  it('holds back an address that may still be arriving, until the line ends', () => {
    const scanner = new DevUrlScanner();
    expect(scanner.feed(encode('http://localhost:51'))).toEqual([]);
    expect(scanner.feed(encode('73/app\n'))).toEqual(['http://localhost:5173/app']);
  });
});
