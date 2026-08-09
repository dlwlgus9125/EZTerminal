import { resolve } from 'node:path';

import { validateDesignStyles } from './design-style-guard-core.mjs';

const root = resolve(import.meta.dirname, '..');
const result = validateDesignStyles(root);
console.log(`guard:design-style OK: ${result.cssFiles} CSS files and ${result.sourceFiles} production source files checked.`);
