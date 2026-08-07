import { resolve } from 'node:path';

import { validateDocumentationContract } from './docs-contract-check-core.mjs';

const root = resolve(import.meta.dirname, '..');
const result = validateDocumentationContract(root);

console.log(
  `docs:check OK: ${result.activeContracts} active contracts, `
  + `${result.archivedDocuments} archived documents, ${result.checkedLinks} local links checked.`,
);
