import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WEBVIEW74_COMPATIBILITY_FEATURES,
  WEBVIEW74_COMPATIBILITY_MARKER,
  WEBVIEW74_COMPATIBILITY_SIGNATURE,
  getMissingWebViewCompatibilityFeatures,
  installAggregateError,
  installArrayAndStringAt,
  installBlobMethods,
  installCryptoRandomUuid,
  installElementReplaceChildren,
  installHTMLElementInert,
  installObjectHasOwn,
  installWeakRef,
  installWebViewCompatibility,
  isWebViewCompatibilityInstalled,
} from './webview-compat';

describe('WebView 74 compatibility primitives', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('provides Object.hasOwn semantics without replacing a native implementation', () => {
    const legacyObject = {} as ObjectConstructor & {
      hasOwn?: (object: object, property: PropertyKey) => boolean;
    };
    installObjectHasOwn(legacyObject);

    expect(legacyObject.hasOwn?.({ own: true }, 'own')).toBe(true);
    expect(legacyObject.hasOwn?.(Object.create({ inherited: true }) as object, 'inherited')).toBe(false);

    const native = vi.fn(() => true);
    const modernObject = { hasOwn: native } as unknown as ObjectConstructor & {
      hasOwn: (object: object, property: PropertyKey) => boolean;
    };
    installObjectHasOwn(modernObject);
    expect(modernObject.hasOwn).toBe(native);
  });

  it('replaces Element children with nodes and strings', () => {
    const legacyPrototype = {} as Element & {
      replaceChildren?: (...nodes: (Node | string)[]) => void;
    };
    installElementReplaceChildren(legacyPrototype);

    const host = document.createElement('div');
    host.innerHTML = '<b>old</b>';
    const suffix = document.createElement('span');
    suffix.textContent = 'world';
    legacyPrototype.replaceChildren?.call(host, 'hello ', suffix);

    expect(host.textContent).toBe('hello world');
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild).toBe(suffix);
  });

  it('provides a strong-reference WeakRef fallback with the same deref contract', () => {
    const legacyGlobal: Record<PropertyKey, unknown> = {};
    installWeakRef(legacyGlobal);
    const WeakRefFallback = legacyGlobal.WeakRef as new <T extends object>(target: T) => { deref(): T | undefined };
    const target = { value: 42 };

    expect(new WeakRefFallback(target).deref()).toBe(target);
    expect(() => new WeakRefFallback(null as never)).toThrow(TypeError);
  });

  it('provides AggregateError errors, message, and cause', () => {
    const legacyGlobal: Record<PropertyKey, unknown> = {};
    installAggregateError(legacyGlobal);
    const AggregateErrorFallback = legacyGlobal.AggregateError as new (
      errors: Iterable<unknown>,
      message?: string,
      options?: { cause?: unknown },
    ) => Error & { readonly errors: unknown[]; readonly cause?: unknown };
    const cause = new Error('root');
    const error = new AggregateErrorFallback([new Error('one'), 'two'], 'combined', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AggregateError');
    expect(error.message).toBe('combined');
    expect(error.errors).toHaveLength(2);
    expect(error.cause).toBe(cause);
  });

  it('reads Blob and File content through FileReader fallbacks', async () => {
    const legacyPrototype = {} as Blob & {
      text?: (this: Blob) => Promise<string>;
      arrayBuffer?: (this: Blob) => Promise<ArrayBuffer>;
    };
    installBlobMethods(legacyPrototype, FileReader);
    const blob = new Blob(['hello ', '\ud55c\uae00'], { type: 'text/plain' });
    const file = new File(['file bytes'], 'sample.txt');

    await expect(legacyPrototype.text?.call(blob)).resolves.toBe('hello \ud55c\uae00');
    const bytes = await legacyPrototype.arrayBuffer?.call(file);
    expect(new TextDecoder().decode(bytes)).toBe('file bytes');
  });

  it('implements negative Array/String at indexes without changing native methods', () => {
    const arrayPrototype: { at?: (this: ArrayLike<unknown>, index?: number) => unknown } = {};
    const stringPrototype: { at?: (this: unknown, index?: number) => unknown } = {};
    installArrayAndStringAt(arrayPrototype, stringPrototype);

    expect(arrayPrototype.at?.call(['a', 'b', 'c'], -1)).toBe('c');
    expect(arrayPrototype.at?.call(['a'], 3)).toBeUndefined();
    expect(stringPrototype.at?.call('abc', -2)).toBe('b');

    const native = vi.fn(() => 'native');
    const modernArray = { at: native };
    installArrayAndStringAt(modernArray, { at: native });
    expect(modernArray.at).toBe(native);
  });

  it('provides an RFC 4122 v4 crypto.randomUUID fallback', () => {
    let seed = 0;
    const legacyCrypto: {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T;
      randomUUID?: () => string;
    } = {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        const bytes = array as Uint8Array;
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed++;
        return array;
      },
    };
    installCryptoRandomUuid(legacyCrypto);

    expect(legacyCrypto.randomUUID?.()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('makes inert subtrees unfocusable and non-interactive when native inert is absent', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert');
    if (original?.configurable) {
      delete (HTMLElement.prototype as unknown as { inert?: boolean }).inert;
    }

    try {
      installHTMLElementInert(HTMLElement.prototype, document);
      const root = document.createElement('section');
      const button = document.createElement('button');
      const onClick = vi.fn();
      button.addEventListener('click', onClick);
      root.appendChild(button);
      document.body.appendChild(root);

      root.inert = true;
      expect(root.hasAttribute('inert')).toBe(true);
      button.click();
      button.focus();
      expect(onClick).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(button);

      root.inert = false;
      button.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'inert', original);
    }
  });

  it('publishes an idempotent feature signature only after installing the full contract', () => {
    installWebViewCompatibility();
    installWebViewCompatibility();

    expect(isWebViewCompatibilityInstalled()).toBe(true);
    expect((globalThis as unknown as Record<PropertyKey, unknown>)[WEBVIEW74_COMPATIBILITY_MARKER])
      .toBe(WEBVIEW74_COMPATIBILITY_SIGNATURE);
    expect(WEBVIEW74_COMPATIBILITY_FEATURES).toContain('Element.replaceChildren');
    expect(WEBVIEW74_COMPATIBILITY_FEATURES).toContain('File.arrayBuffer');
    expect(getMissingWebViewCompatibilityFeatures()).toEqual([]);
  });

  it('does not trust the signature when a runtime postcondition is missing', () => {
    const blobPrototype = { text: vi.fn(), arrayBuffer: vi.fn() };
    const fakeGlobal = {
      Object: { hasOwn: vi.fn() },
      Element: { prototype: { replaceChildren: vi.fn() } },
      WeakRef: vi.fn(),
      AggregateError: undefined,
      Blob: { prototype: blobPrototype },
      File: { prototype: Object.create(blobPrototype) as object },
      Array: { prototype: { at: vi.fn() } },
      String: { prototype: { at: vi.fn() } },
      crypto: { randomUUID: vi.fn() },
      HTMLElement: { prototype: { inert: false } },
      [WEBVIEW74_COMPATIBILITY_MARKER]: WEBVIEW74_COMPATIBILITY_SIGNATURE,
    } as unknown as typeof globalThis;

    expect(getMissingWebViewCompatibilityFeatures(fakeGlobal)).toEqual(['AggregateError']);
    expect(isWebViewCompatibilityInstalled(fakeGlobal)).toBe(false);
  });
});
