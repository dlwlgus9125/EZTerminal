/**
 * Runtime compatibility for the oldest supported Android 10 WebView
 * (Chrome/WebView 74). Vite lowers syntax, but it deliberately does not
 * polyfill browser APIs used by application dependencies.
 *
 * Keep this module dependency-free. `bootstrap.ts` installs it synchronously
 * before dynamically importing the React application graph.
 */

export const WEBVIEW74_COMPATIBILITY_MARKER = '__EZTERMINAL_WEBVIEW74_COMPAT_V1__';

export const WEBVIEW74_COMPATIBILITY_FEATURES = Object.freeze([
  'Object.hasOwn',
  'Element.replaceChildren',
  'WeakRef',
  'AggregateError',
  'Blob.text',
  'Blob.arrayBuffer',
  'File.text',
  'File.arrayBuffer',
  'Array.prototype.at',
  'String.prototype.at',
  'crypto.randomUUID',
  'HTMLElement.inert',
] as const);

export const WEBVIEW74_COMPATIBILITY_SIGNATURE =
  `${WEBVIEW74_COMPATIBILITY_MARKER}:${WEBVIEW74_COMPATIBILITY_FEATURES.join(',')}`;

type PropertyBag = Record<PropertyKey, unknown>;

type HasOwnCompatibleObjectConstructor = ObjectConstructor & {
  hasOwn?: (object: object, property: PropertyKey) => boolean;
};

type ReplaceChildrenCompatibleElement = Element & {
  replaceChildren?: (...nodes: (Node | string)[]) => void;
};

type BlobMethodsCompatiblePrototype = Blob & {
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

type AtCompatiblePrototype = {
  at?: (index: number) => unknown;
};

type CryptoRandomUuidCompatible = Pick<Crypto, 'getRandomValues'> & {
  randomUUID?: () => string;
};

function defineMethod(target: object, name: PropertyKey, value: unknown): void {
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  });
}

export function installObjectHasOwn(
  objectConstructor: HasOwnCompatibleObjectConstructor = Object,
): void {
  if (typeof objectConstructor.hasOwn === 'function') return;
  defineMethod(
    objectConstructor,
    'hasOwn',
    (object: object, property: PropertyKey): boolean => (
      Object.prototype.hasOwnProperty.call(object, property)
    ),
  );
}

function isNodeLike(value: unknown): value is Node {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const candidate = value as { readonly nodeType?: unknown; readonly nodeName?: unknown };
  return typeof candidate.nodeType === 'number' && typeof candidate.nodeName === 'string';
}

export function installElementReplaceChildren(
  elementPrototype: ReplaceChildrenCompatibleElement = Element.prototype,
): void {
  if (typeof elementPrototype.replaceChildren === 'function') return;

  defineMethod(
    elementPrototype,
    'replaceChildren',
    function replaceChildren(this: Element, ...nodes: (Node | string)[]): void {
      const ownerDocument = this.ownerDocument;
      const replacement = ownerDocument.createDocumentFragment();
      for (const node of nodes) {
        replacement.appendChild(
          isNodeLike(node) ? node : ownerDocument.createTextNode(String(node)),
        );
      }
      while (this.firstChild) this.removeChild(this.firstChild);
      this.appendChild(replacement);
    },
  );
}

export function installWeakRef(globalObject: PropertyBag = globalThis as unknown as PropertyBag): void {
  if (typeof globalObject.WeakRef === 'function') return;

  const StrongWeakRef = class WeakRef<T extends object> {
    private readonly target: T;

    constructor(target: T) {
      if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
        throw new TypeError('WeakRef target must be an object');
      }
      this.target = target;
    }

    deref(): T | undefined {
      return this.target;
    }

    get [Symbol.toStringTag](): string {
      return 'WeakRef';
    }
  };

  defineMethod(globalObject, 'WeakRef', StrongWeakRef);
}

export function installAggregateError(globalObject: PropertyBag = globalThis as unknown as PropertyBag): void {
  if (typeof globalObject.AggregateError === 'function') return;

  const AggregateErrorFallback = class AggregateError extends Error {
    readonly errors!: unknown[];

    constructor(errors: Iterable<unknown> | ArrayLike<unknown>, message?: string, options?: { cause?: unknown }) {
      super(message === undefined ? '' : String(message));
      this.name = 'AggregateError';
      Object.setPrototypeOf(this, new.target.prototype);
      Object.defineProperty(this, 'errors', {
        configurable: true,
        writable: true,
        value: Array.from(errors),
      });
      if (options && Object.prototype.hasOwnProperty.call(options, 'cause')) {
        Object.defineProperty(this, 'cause', {
          configurable: true,
          writable: true,
          value: options.cause,
        });
      }
    }
  };

  defineMethod(globalObject, 'AggregateError', AggregateErrorFallback);
}

function readBlob(
  blob: Blob,
  FileReaderConstructor: typeof FileReader,
  mode: 'text' | 'arrayBuffer',
): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReaderConstructor();
    reader.onload = () => {
      const { result } = reader;
      if (mode === 'text' && typeof result === 'string') resolve(result);
      else if (mode === 'arrayBuffer' && result instanceof ArrayBuffer) resolve(result);
      else reject(new TypeError(`FileReader returned an invalid ${mode} result`));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'));
    reader.onabort = () => reject(reader.error ?? new Error('Blob read aborted'));
    if (mode === 'text') reader.readAsText(blob);
    else reader.readAsArrayBuffer(blob);
  });
}

export function installBlobMethods(
  blobPrototype: BlobMethodsCompatiblePrototype = Blob.prototype,
  FileReaderConstructor: typeof FileReader = FileReader,
): void {
  if (typeof blobPrototype.text !== 'function') {
    defineMethod(blobPrototype, 'text', function text(this: Blob): Promise<string> {
      return readBlob(this, FileReaderConstructor, 'text') as Promise<string>;
    });
  }
  if (typeof blobPrototype.arrayBuffer !== 'function') {
    defineMethod(blobPrototype, 'arrayBuffer', function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
      return readBlob(this, FileReaderConstructor, 'arrayBuffer') as Promise<ArrayBuffer>;
    });
  }
}

function normalizeAtIndex(index: number, length: number): number | null {
  let relativeIndex = Number(index);
  if (Number.isNaN(relativeIndex)) relativeIndex = 0;
  else if (relativeIndex !== Infinity && relativeIndex !== -Infinity) {
    relativeIndex = relativeIndex < 0 ? Math.ceil(relativeIndex) : Math.floor(relativeIndex);
  }
  const resolved = relativeIndex >= 0 ? relativeIndex : length + relativeIndex;
  return resolved < 0 || resolved >= length ? null : resolved;
}

export function installArrayAndStringAt(
  arrayPrototype: AtCompatiblePrototype = Array.prototype,
  stringPrototype: AtCompatiblePrototype = String.prototype,
): void {
  if (typeof arrayPrototype.at !== 'function') {
    defineMethod(arrayPrototype, 'at', function at(this: ArrayLike<unknown>, index = 0): unknown {
      if (this === null || this === undefined) throw new TypeError('Array.prototype.at called on null or undefined');
      const object = Object(this) as ArrayLike<unknown>;
      const length = Math.min(Math.max(Number(object.length) || 0, 0), Number.MAX_SAFE_INTEGER);
      const resolved = normalizeAtIndex(index, Math.floor(length));
      return resolved === null ? undefined : object[resolved];
    });
  }

  if (typeof stringPrototype.at !== 'function') {
    defineMethod(stringPrototype, 'at', function at(this: unknown, index = 0): string | undefined {
      if (this === null || this === undefined) throw new TypeError('String.prototype.at called on null or undefined');
      const value = String(this);
      const resolved = normalizeAtIndex(index, value.length);
      return resolved === null ? undefined : value.charAt(resolved);
    });
  }
}

export function installCryptoRandomUuid(
  cryptoObject: CryptoRandomUuidCompatible = crypto,
): void {
  if (typeof cryptoObject.randomUUID === 'function') return;
  defineMethod(cryptoObject, 'randomUUID', function randomUUID(): string {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}

const inertFallbackDocuments = new WeakSet<Document>();
const INERT_FALLBACK_STYLE_ID = 'ezterminal-webview74-inert';

function eventTargetsInertSubtree(event: Event): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  for (const target of path) {
    const candidate = target as { readonly nodeType?: unknown; hasAttribute?: (name: string) => boolean };
    if (candidate?.nodeType === 1 && candidate.hasAttribute?.('inert')) return true;
  }
  return false;
}

function installInertEventGuards(documentObject: Document): void {
  if (inertFallbackDocuments.has(documentObject)) return;
  inertFallbackDocuments.add(documentObject);

  const suppressInteraction = (event: Event): void => {
    if (!eventTargetsInertSubtree(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const suppressFocus = (event: Event): void => {
    if (!eventTargetsInertSubtree(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target as { blur?: () => void } | null;
    target?.blur?.();
  };

  for (const eventName of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keypress', 'keyup']) {
    documentObject.addEventListener(eventName, suppressInteraction, true);
  }
  documentObject.addEventListener('focus', suppressFocus, true);
  documentObject.addEventListener('focusin', suppressFocus, true);

  if (!documentObject.getElementById(INERT_FALLBACK_STYLE_ID)) {
    const style = documentObject.createElement('style');
    style.id = INERT_FALLBACK_STYLE_ID;
    style.textContent = '[inert]{pointer-events:none!important;user-select:none!important;-webkit-user-select:none!important}';
    (documentObject.head ?? documentObject.documentElement).appendChild(style);
  }
}

export function installHTMLElementInert(
  htmlElementPrototype: HTMLElement = HTMLElement.prototype,
  documentObject: Document = document,
): void {
  if ('inert' in htmlElementPrototype) return;

  Object.defineProperty(htmlElementPrototype, 'inert', {
    configurable: true,
    enumerable: true,
    get(this: HTMLElement): boolean {
      return this.hasAttribute('inert');
    },
    set(this: HTMLElement, value: boolean) {
      if (value) this.setAttribute('inert', '');
      else this.removeAttribute('inert');
    },
  });
  installInertEventGuards(documentObject);
}

export function getMissingWebViewCompatibilityFeatures(
  globalObject: typeof globalThis = globalThis,
): string[] {
  const globals = globalObject as unknown as PropertyBag;
  const blobPrototype = globalObject.Blob.prototype as BlobMethodsCompatiblePrototype;
  const filePrototype = globalObject.File.prototype as BlobMethodsCompatiblePrototype;
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ['Object.hasOwn', typeof (globalObject.Object as HasOwnCompatibleObjectConstructor).hasOwn === 'function'],
    ['Element.replaceChildren', typeof (globalObject.Element.prototype as ReplaceChildrenCompatibleElement).replaceChildren === 'function'],
    ['WeakRef', typeof globals.WeakRef === 'function'],
    ['AggregateError', typeof globals.AggregateError === 'function'],
    ['Blob.text', typeof blobPrototype.text === 'function'],
    ['Blob.arrayBuffer', typeof blobPrototype.arrayBuffer === 'function'],
    ['File.text', typeof filePrototype.text === 'function'],
    ['File.arrayBuffer', typeof filePrototype.arrayBuffer === 'function'],
    ['Array.prototype.at', typeof (globalObject.Array.prototype as AtCompatiblePrototype).at === 'function'],
    ['String.prototype.at', typeof (globalObject.String.prototype as AtCompatiblePrototype).at === 'function'],
    ['crypto.randomUUID', typeof (globalObject.crypto as CryptoRandomUuidCompatible).randomUUID === 'function'],
    ['HTMLElement.inert', 'inert' in globalObject.HTMLElement.prototype],
  ];
  return checks.filter(([, installed]) => !installed).map(([feature]) => feature);
}

export function installWebViewCompatibility(
  globalObject: typeof globalThis = globalThis,
): void {
  const globals = globalObject as unknown as PropertyBag;
  installObjectHasOwn(globalObject.Object as HasOwnCompatibleObjectConstructor);
  installElementReplaceChildren(globalObject.Element.prototype as ReplaceChildrenCompatibleElement);
  installWeakRef(globals);
  installAggregateError(globals);
  installBlobMethods(
    globalObject.Blob.prototype as BlobMethodsCompatiblePrototype,
    globalObject.FileReader,
  );
  installArrayAndStringAt(
    globalObject.Array.prototype as AtCompatiblePrototype,
    globalObject.String.prototype as AtCompatiblePrototype,
  );
  installCryptoRandomUuid(globalObject.crypto as CryptoRandomUuidCompatible);
  installHTMLElementInert(globalObject.HTMLElement.prototype, globalObject.document);

  const missingFeatures = getMissingWebViewCompatibilityFeatures(globalObject);
  if (missingFeatures.length > 0) {
    throw new Error(`WebView compatibility postcondition failed: ${missingFeatures.join(', ')}`);
  }

  Object.defineProperty(globals, WEBVIEW74_COMPATIBILITY_MARKER, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: WEBVIEW74_COMPATIBILITY_SIGNATURE,
  });
}

export function isWebViewCompatibilityInstalled(
  globalObject: typeof globalThis = globalThis,
): boolean {
  return (globalObject as unknown as PropertyBag)[WEBVIEW74_COMPATIBILITY_MARKER]
    === WEBVIEW74_COMPATIBILITY_SIGNATURE
    && getMissingWebViewCompatibilityFeatures(globalObject).length === 0;
}
