import { describe, expect, it } from 'vitest';

import type { ApprovalRequest } from './approval-request';
import { browserActionOf, isBrowserActionRequest, looksSecret, siteClass } from './browser';

const ALLOWED = ['https://staging.cart-kit.example'];

describe('siteClass: the class of the current URL, by name alone', () => {
  it.each([
    ['http://localhost:5173/cart', 'local'],
    ['http://foo.localhost:3000/', 'local'],
    ['http://127.0.0.1:8080/', 'local'],
    ['http://127.8.8.8/', 'local'],
    ['http://[::1]:5173/', 'local'],
    ['file:///C:/Working/cart-kit/index.html', 'file'],
    ['https://staging.cart-kit.example/cart', 'allowed'],
  ] as const)('%s is %s', (url, expected) => {
    expect(siteClass(url, ALLOWED)).toBe(expected);
  });

  it.each([
    'https://docs.payments-partner.example/status',
    // The exact origin only: another port, scheme or subdomain is another site.
    'https://staging.cart-kit.example:8443/',
    'http://staging.cart-kit.example/',
    'https://www.staging.cart-kit.example/',
    // Fails closed on everything that only looks local.
    'http://localhost./',
    'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0/',
    'http://192.168.0.10/',
    'http://printer.local/',
    'http://user:pass@localhost:5173/',
    'not a url',
  ])('%s is external', (url) => {
    expect(siteClass(url, ALLOWED)).toBe('external');
  });
});

describe('browserActionOf: what will run comes from the host, the element name from the page', () => {
  const request = (toolName: string, input: unknown): ApprovalRequest => ({ v: 1, kind: 'tool', toolName, target: ALLOWED[0]!, input: JSON.stringify(input) });

  it('shows the full URL of a navigation', () => {
    expect(browserActionOf(request('browser_navigate', { url: 'https://staging.cart-kit.example/checkout?step=2' }))?.run).toEqual({ kind: 'navigate', url: 'https://staging.cart-kit.example/checkout?step=2' });
  });

  it('shows the value to type, apart from the name the page gives the field', () => {
    const view = browserActionOf(request('browser_type', { value: 'SPRING', element: 'textbox "Coupon"' }));
    expect(view?.run).toEqual({ kind: 'type', value: 'SPRING' });
    expect(view?.pageElement).toBe('textbox "Coupon"');
  });

  it('shows the keys', () => {
    expect(browserActionOf(request('browser_press', { keys: 'Control+Enter' }))?.run).toEqual({ kind: 'press', keys: 'Control+Enter' });
  });

  it('has nothing more to say about a click than the click', () => {
    expect(browserActionOf(request('browser_click', { element: 'button "Pay"' }))?.run).toEqual({ kind: 'click' });
  });

  it('shows no browser card when what will run cannot be read: the generic dock shows the raw input', () => {
    expect(browserActionOf({ v: 1, kind: 'tool', toolName: 'browser_type', target: ALLOWED[0]!, input: 'not json' })).toBeUndefined();
    expect(browserActionOf(request('browser_type', { element: 'textbox' }))).toBeUndefined();
    expect(browserActionOf(request('browser_navigate', {}))).toBeUndefined();
    expect(browserActionOf(request('browser_snapshot', {}))).toBeUndefined();
  });

  it('tells a browser action by its prefix', () => {
    expect(isBrowserActionRequest('browser-action:call-9')).toBe(true);
    expect(isBrowserActionRequest('call-9')).toBe(false);
    expect(isBrowserActionRequest(undefined)).toBe(false);
  });
});

describe('looksSecret', () => {
  it.each([
    'sk-fixture-not-a-real-key-0000', 'ghp_abc123', 'xoxb-1-2', 'AKIAEXAMPLE', 'eyJhbGciOi.payload.signature',
    'password=hunter2', 'API_KEY: abc', 'a1b2c3d4e5f6a7b8c9d0e1',
  ])('masks %s', (value) => {
    expect(looksSecret(value)).toBe(true);
  });

  it.each(['SPRING', '32,500', 'test@example.com', '장바구니 쿠폰', 'a long sentence with 12 words and spaces in it', ''])('shows %s', (value) => {
    expect(looksSecret(value)).toBe(false);
  });
});
