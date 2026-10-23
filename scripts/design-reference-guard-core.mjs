import ts from 'typescript';

const EXPECTED_AXES = {
  accessibility: [
    'axe',
    'keyboard',
    'focus-restore',
    'reduced-motion',
    'no-horizontal-scroll',
  ],
  locales: ['ko', 'en'],
  scalePercent: [100, 150],
  themes: ['matrix', 'light', 'dark', 'high-contrast'],
  viewports: [
    '800x600',
    '1024x720',
    '1200x800',
    '1440x900',
    '1920-reference',
  ],
};

const EXPECTED_SOURCE_ROLES = {
  canonicalPrototype: ['EZTerminal-desktop-prototype.dc.html'],
  historicalNonAcceptance: ['EZTerminal-desktop-options.dc.html'],
  implementationAndQa: ['HANDOFF-README.md'],
  packageContext: ['PACKAGE2-README.md'],
  supportingImportClosure: ['support.js'],
  visualReferences: Array.from(
    { length: 14 },
    (_, index) => `${String(index + 1).padStart(2, '0')}-shot.png`,
  ),
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function assertCanonicalPng(bytes, snapshot) {
  assert(
    bytes.length > PNG_SIGNATURE.length
      && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte),
    `Canonical snapshot does not have a valid PNG signature: ${snapshot}.`,
  );
}

function parseTsx(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function visit(node, predicate, matches = []) {
  if (predicate(node)) matches.push(node);
  ts.forEachChild(node, (child) => {
    visit(child, predicate, matches);
  });
  return matches;
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property) {
  const { name } = property;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function propertyValue(object, name) {
  const property = object.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate)
      && propertyName(candidate) === name,
  );
  return property ? unwrap(property.initializer) : null;
}

function stringValue(expression) {
  return expression && ts.isStringLiteralLike(expression)
    ? expression.text
    : null;
}

function numberValue(expression) {
  return expression && ts.isNumericLiteral(expression)
    ? Number(expression.text)
    : null;
}

function arrayVariable(sourceFile, name) {
  const declaration = visit(
    sourceFile,
    (node) => ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name,
  )[0];
  assert(declaration?.initializer, `Visual contract is missing ${name}.`);
  const initializer = unwrap(declaration.initializer);
  assert(
    ts.isArrayLiteralExpression(initializer),
    `Visual contract ${name} must be a literal array.`,
  );
  return initializer;
}

function objectElements(array, name) {
  const elements = array.elements.map((element) => unwrap(element));
  assert(
    elements.every(ts.isObjectLiteralExpression),
    `${name} must contain only literal case objects.`,
  );
  return elements;
}

function exportedConstNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement)
      || !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

function findForOf(sourceFile, collectionName) {
  return visit(
    sourceFile,
    (node) => ts.isForOfStatement(node)
      && ts.isIdentifier(unwrap(node.expression))
      && unwrap(node.expression).text === collectionName,
  )[0];
}

function directCallName(call) {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

function methodCallName(call) {
  return ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : null;
}

function callsWithin(node) {
  return visit(node, ts.isCallExpression);
}

function stringLiteralsWithin(node) {
  return new Set(
    visit(node, ts.isStringLiteralLike).map((literal) => literal.text),
  );
}

function identifiersWithin(node) {
  return new Set(visit(node, ts.isIdentifier).map((identifier) => identifier.text));
}

function assertSet(actual, expected, label) {
  assert(Array.isArray(actual), `Manifest ${label} must be an array.`);
  const actualSet = new Set(actual);
  assert(
    actual.length === actualSet.size
      && actualSet.size === expected.length
      && expected.every((value) => actualSet.has(value)),
    `Manifest ${label} must be exactly: ${expected.join(', ')}.`,
  );
}

function callWithTitle(sourceFile, callerName, titleFragment) {
  return visit(
    sourceFile,
    (node) => {
      if (!ts.isCallExpression(node) || directCallName(node) !== callerName) return false;
      const title = stringValue(node.arguments[0] ? unwrap(node.arguments[0]) : null);
      return title?.includes(titleFragment) ?? false;
    },
  )[0];
}

function validateManifest(manifest) {
  assert(manifest?.schemaVersion === 1, 'Desktop handoff manifest schema must be 1.');
  assert(
    Array.isArray(manifest.surfaces) && manifest.surfaces.length === 14,
    'Desktop handoff manifest must contain exactly fourteen surfaces.',
  );

  const ids = new Set();
  const storyIds = new Set();
  const storyExports = new Set();
  for (const surface of manifest.surfaces) {
    assert(
      typeof surface.id === 'string' && !ids.has(surface.id),
      `Desktop handoff surface id is missing or duplicated: ${surface.id}.`,
    );
    assert(
      typeof surface.storyId === 'string' && !storyIds.has(surface.storyId),
      `Desktop handoff story id is missing or duplicated: ${surface.storyId}.`,
    );
    assert(
      typeof surface.storyExport === 'string' && !storyExports.has(surface.storyExport),
      `Desktop handoff story export is missing or duplicated for ${surface.id}.`,
    );
    ids.add(surface.id);
    storyIds.add(surface.storyId);
    storyExports.add(surface.storyExport);
  }

  for (const [axis, expected] of Object.entries(EXPECTED_AXES)) {
    assertSet(manifest.requiredAxes?.[axis], expected, `requiredAxes.${axis}`);
  }

  assert(
    manifest.authority?.supportingImportClosure?.includes('support.js')
      && manifest.authority.supportingImportClosure.includes('required import'),
    'Manifest authority must define support.js as supporting import closure.',
  );
  assert(
    manifest.authority?.historicalNonAcceptance?.includes(
      'EZTerminal-desktop-options.dc.html',
    )
      && manifest.authority.historicalNonAcceptance.includes('non-canonical'),
    'Manifest authority must define options history as historical non-acceptance.',
  );

  const roleNames = Object.keys(manifest.sourceRoles ?? {});
  assertSet(
    roleNames,
    Object.keys(EXPECTED_SOURCE_ROLES),
    'sourceRoles keys',
  );
  const roleFiles = [];
  for (const [role, expectedFiles] of Object.entries(EXPECTED_SOURCE_ROLES)) {
    assertSet(manifest.sourceRoles[role], expectedFiles, `sourceRoles.${role}`);
    roleFiles.push(...manifest.sourceRoles[role]);
  }
  assert(
    roleFiles.length === new Set(roleFiles).size,
    'Manifest sourceRoles must assign every pinned source to exactly one role.',
  );

  const extractedEntries = Object.entries(manifest.extractedFiles ?? {});
  assert(
    extractedEntries.length === 19,
    'Desktop handoff manifest must pin exactly 19 source files.',
  );
  for (const [name, hash] of extractedEntries) {
    assert(
      typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash),
      `Desktop handoff source ${name} needs a lowercase SHA-256 hash.`,
    );
  }
  assertSet(
    roleFiles,
    extractedEntries.map(([name]) => name),
    'sourceRoles file coverage',
  );
}

function validateStories(manifest, storySource) {
  const sourceFile = parseTsx(storySource, 'DesktopHandoff.stories.tsx');
  const exports = exportedConstNames(sourceFile);
  for (const surface of manifest.surfaces) {
    assert(
      exports.has(surface.storyExport),
      `Story export ${surface.storyExport} for ${surface.storyId} is missing.`,
    );
  }

  const title = storySource.match(
    /title\s*:\s*(['"])Compositions\/Desktop Handoff\1/u,
  );
  assert(title, 'Desktop handoff stories must keep the manifest-bound Storybook title.');
}

function validateCanonicalCases(manifest, sourceFile, availableSnapshots, retiredStoryIds = new Set()) {
  assert(
    availableSnapshots instanceof Set,
    'Desktop handoff guard requires the availableSnapshots file set.',
  );
  // A retired surface's old case may linger until it is deleted; it is no longer the reference.
  const cases = objectElements(
    arrayVariable(sourceFile, 'desktopHandoffCases'),
    'desktopHandoffCases',
  ).filter((visualCase) => !retiredStoryIds.has(stringValue(propertyValue(visualCase, 'storyId'))));
  assert(
    cases.length === manifest.surfaces.length,
    'Canonical visual cases must map one-to-one to manifest surfaces.',
  );

  const caseByStoryId = new Map();
  const screenshots = new Set();
  for (const visualCase of cases) {
    const storyId = stringValue(propertyValue(visualCase, 'storyId'));
    const screenshot = stringValue(propertyValue(visualCase, 'screenshot'));
    const readySelector = stringValue(propertyValue(visualCase, 'readySelector'));
    const locale = stringValue(propertyValue(visualCase, 'locale'));
    assert(storyId, 'Every canonical visual case needs a literal storyId.');
    assert(
      !caseByStoryId.has(storyId),
      `Canonical visual case is duplicated for ${storyId}.`,
    );
    assert(
      screenshot
        && /^[a-z0-9][a-z0-9._-]*\.png$/u.test(screenshot)
        && !screenshots.has(screenshot),
      `Canonical visual case ${storyId} needs a unique PNG screenshot.`,
    );
    assert(
      availableSnapshots.has(screenshot),
      `Canonical snapshot file is missing: ${screenshot}.`,
    );
    assert(
      typeof readySelector === 'string' && readySelector.length > 0,
      `Canonical visual case ${storyId} needs a readySelector.`,
    );
    assert(
      locale === 'ko' || locale === 'en',
      `Canonical visual case ${storyId} needs a supported locale.`,
    );
    caseByStoryId.set(storyId, visualCase);
    screenshots.add(screenshot);
  }
  for (const surface of manifest.surfaces) {
    assert(
      caseByStoryId.has(surface.storyId),
      `Canonical visual case for ${surface.storyId} is missing.`,
    );
  }

  const loop = findForOf(sourceFile, 'desktopHandoffCases');
  assert(loop, 'Canonical visual cases must be executed by a for-of test loop.');
  const calls = callsWithin(loop);
  const openStoryCalls = calls.filter((call) => directCallName(call) === 'openStory');
  assert(
    openStoryCalls.length >= 2,
    'Each canonical surface must render both its primary and alternate locale.',
  );
  const openStoryText = openStoryCalls.map((call) => call.getText(sourceFile));
  assert(
    openStoryText.some((text) => /locale\s*:\s*handoffCase\.locale/u.test(text))
      && openStoryText.some((text) => /locale\s*:\s*alternateLocale/u.test(text)),
    'Canonical locale coverage must bind both handoffCase.locale and alternateLocale.',
  );

  const alternateLocale = visit(
    loop,
    (node) => ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'alternateLocale',
  )[0];
  assert(
    alternateLocale?.initializer,
    'Canonical visual loop must declare alternateLocale.',
  );
  const alternateValues = stringLiteralsWithin(alternateLocale.initializer);
  assert(
    alternateValues.has('ko') && alternateValues.has('en'),
    'alternateLocale must switch between Korean and English.',
  );

  const loopStrings = stringLiteralsWithin(loop);
  assert(
    loopStrings.has('btn-new-tab')
      && loopStrings.has('새 터미널')
      && loopStrings.has('New Terminal'),
    'Canonical locale coverage must verify localized product content.',
  );
  assert(
    calls.filter(
      (call) => directCallName(call) === 'expectNoAccessibilityViolations',
    ).length >= 2,
    'Each canonical surface must run axe in both locales.',
  );
  assert(
    calls.some((call) => methodCallName(call) === 'toHaveScreenshot'),
    'Each canonical surface must have a screenshot assertion.',
  );
  const identifiers = identifiersWithin(loop);
  assert(
    identifiers.has('scrollWidth') && identifiers.has('innerWidth'),
    'Each canonical surface must assert that it has no horizontal overflow.',
  );
  return [...screenshots];
}

function validateResponsiveAxes(sourceFile) {
  const cases = objectElements(
    arrayVariable(sourceFile, 'desktopHandoffAxisCases'),
    'desktopHandoffAxisCases',
  );
  const viewports = new Set();
  const themes = new Set(['matrix']);
  const scales = new Set();
  const sidebarModes = new Set();
  for (const axisCase of cases) {
    const viewport = propertyValue(axisCase, 'viewport');
    assert(
      viewport && ts.isObjectLiteralExpression(viewport),
      'Every responsive visual case needs a literal viewport.',
    );
    const width = numberValue(propertyValue(viewport, 'width'));
    const height = numberValue(propertyValue(viewport, 'height'));
    viewports.add(`${width}x${height}`);
    themes.add(stringValue(propertyValue(axisCase, 'theme')));
    scales.add(numberValue(propertyValue(axisCase, 'scale')));
    sidebarModes.add(stringValue(propertyValue(axisCase, 'sidebarMode')));
  }
  for (const viewport of ['800x600', '1024x720', '1200x800', '1440x900']) {
    assert(viewports.has(viewport), `Responsive visual matrix is missing ${viewport}.`);
  }
  for (const theme of EXPECTED_AXES.themes) {
    assert(themes.has(theme), `Responsive visual matrix is missing ${theme}.`);
  }
  for (const scale of EXPECTED_AXES.scalePercent) {
    assert(scales.has(scale), `Responsive visual matrix is missing ${scale}% scale.`);
  }
  assert(
    sidebarModes.has('overlay') && sidebarModes.has('reflow'),
    'Responsive visual matrix must cover both overlay and reflow sidebars.',
  );

  const loop = findForOf(sourceFile, 'desktopHandoffAxisCases');
  assert(loop, 'Responsive visual cases must be executed by a for-of test loop.');
  const calls = callsWithin(loop);
  const strings = stringLiteralsWithin(loop);
  const identifiers = identifiersWithin(loop);
  for (const key of ['Shift+Tab', 'Escape', 'aria-modal']) {
    assert(strings.has(key), `Responsive interaction contract is missing ${key}.`);
  }
  for (const method of ['toBeFocused', 'toHaveScreenshot']) {
    assert(
      calls.some((call) => methodCallName(call) === method),
      `Responsive interaction contract is missing ${method}.`,
    );
  }
  assert(
    calls.some((call) => directCallName(call) === 'expectNoAccessibilityViolations'),
    'Responsive cases must run axe.',
  );
  assert(
    identifiers.has('scrollWidth')
      && identifiers.has('scrollHeight')
      && identifiers.has('innerWidth')
      && identifiers.has('innerHeight'),
    'Responsive cases must assert two-dimensional overflow containment.',
  );
}

function validateFixtureIntegrity(sourceFile) {
  const suite = callWithTitle(sourceFile, 'test', 'workbench fixture includes');
  assert(suite, 'Visual contract is missing the production workbench fixture test.');
  const source = sourceFile.getFullText();
  const requiredMarkers = [
    'quick-command-shelf',
    'agent-aware-tab',
    'pane-header-cwd',
    'desktop handoff fixture integrity',
    'Command Center fixture contains every production result kind',
    'Settings fixture follows the selected global theme',
  ];
  for (const marker of requiredMarkers) {
    assert(source.includes(marker), `Fixture integrity contract is missing ${marker}.`);
  }
  for (const kind of [
    'pane',
    'background-session',
    'file',
    'history',
    'quick-command',
    'action',
    'preset',
    'agent',
  ]) {
    assert(source.includes(`"${kind}"`), `Command Center fixture guard is missing ${kind}.`);
  }
}

function validateReducedMotion(sourceFile) {
  const reducedTest = callWithTitle(sourceFile, 'test', 'reduced motion skips');
  assert(reducedTest, 'Visual contract is missing the reduced-motion behavior test.');
  const strings = stringLiteralsWithin(reducedTest);
  const freezeProperty = visit(
    reducedTest,
    (node) => ts.isPropertyAssignment(node)
      && propertyName(node) === 'freezeAnimations',
  )[0];
  assert(
    freezeProperty && freezeProperty.initializer.kind === ts.SyntaxKind.FalseKeyword,
    'Reduced-motion behavior must run without the visual animation freezer.',
  );
  for (const marker of ['boot-intro', 'animation-duration', '0s']) {
    assert(strings.has(marker), `Reduced-motion behavior is missing ${marker}.`);
  }
}

function validateElectronGeometryAndFocus(e2eSource) {
  const sourceFile = parseTsx(e2eSource, 'workbench-shell.spec.ts');
  const strings = stringLiteralsWithin(sourceFile);
  for (const label of [
    '800x600@100',
    '800x600@150',
    '1024x720@100',
    '1024x720@150',
  ]) {
    assert(strings.has(label), `Electron geometry matrix is missing ${label}.`);
  }

  const focusTest = callWithTitle(sourceFile, 'test', 'focus-restoring overlay sidebar');
  assert(focusTest, 'Electron contract is missing the real focus-restoring sidebar path.');
  const focusStrings = stringLiteralsWithin(focusTest);
  const focusCalls = callsWithin(focusTest);
  for (const marker of [
    'btn-command-center',
    'btn-toggle-files',
    'Shift+Tab',
    'Escape',
    'inert',
  ]) {
    assert(focusStrings.has(marker), `Electron focus contract is missing ${marker}.`);
  }
  const focusIdentifiers = identifiersWithin(focusTest);
  assert(
    focusIdentifiers.has('activeElement')
      && focusCalls.some((call) => methodCallName(call) === 'toBe'),
    'Electron focus contract must assert focus restoration.',
  );
}

const LEGACY_MANIFEST_PATH = 'docs/ux/reference/desktop-handoff/manifest.json';
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/u;

function requireString(value, label) {
  assert(typeof value === 'string' && value.trim().length > 0, `2.0 reference ${label} is required.`);
}

/**
 * The 2.0 design reference: approved surfaces plus the archived 1.0 handoff
 * surfaces that are still guarded as legacy. Every 1.0 surface must be either
 * still legacy or replaced by exactly one approved surface, so nothing drops
 * out of the guard while the overhaul replaces screens one bundle at a time.
 */
export function validateDesignReferenceManifest(manifest, legacyManifest) {
  assert(manifest?.schemaVersion === 1, '2.0 reference manifest must use schemaVersion 1.');
  assert(manifest.status === 'active', '2.0 reference manifest must be active.');
  assert(
    manifest.legacy?.manifest === LEGACY_MANIFEST_PATH,
    `2.0 reference must name the archived handoff manifest ${LEGACY_MANIFEST_PATH}.`,
  );
  assert(Array.isArray(manifest.legacy.surfaces), '2.0 reference legacy.surfaces must be a list.');
  assert(Array.isArray(manifest.approved), '2.0 reference approved must be a list.');

  const handoffIds = new Set((legacyManifest?.surfaces ?? []).map((surface) => surface.id));
  const legacy = [...manifest.legacy.surfaces];
  const approvedIds = new Set();
  const retired = [];
  for (const entry of manifest.approved) {
    requireString(entry?.id, 'approved[].id');
    assert(IDENTIFIER.test(entry.id), `2.0 reference approved id ${entry.id} must be kebab-case.`);
    assert(!approvedIds.has(entry.id), `2.0 reference approved id ${entry.id} is duplicated.`);
    approvedIds.add(entry.id);
    requireString(entry.title, `${entry.id}.title`);
    requireString(entry.story?.file, `${entry.id}.story.file`);
    requireString(entry.story?.export, `${entry.id}.story.export`);
    requireString(entry.visual?.storyId, `${entry.id}.visual.storyId`);
    requireString(entry.visual?.snapshot, `${entry.id}.visual.snapshot`);
    requireString(entry.capture?.file, `${entry.id}.capture.file`);
    assert(SHA256.test(entry.capture?.sha256 ?? ''), `2.0 reference ${entry.id}.capture.sha256 must be a lowercase SHA-256.`);
    requireString(entry.approval?.record, `${entry.id}.approval.record`);
    requireString(entry.approval?.decidedAt, `${entry.id}.approval.decidedAt`);
    assert(Array.isArray(entry.replaces ?? []), `2.0 reference ${entry.id}.replaces must be a list.`);
    for (const id of entry.replaces ?? []) {
      assert(handoffIds.has(id), `2.0 reference ${entry.id} replaces unknown 1.0 surface ${id}.`);
      assert(!retired.includes(id), `1.0 surface ${id} is replaced by more than one approved surface.`);
      assert(!legacy.includes(id), `1.0 surface ${id} is both legacy and replaced.`);
      retired.push(id);
    }
  }
  for (const id of legacy) {
    assert(handoffIds.has(id), `2.0 reference lists unknown legacy surface ${id}.`);
  }
  assert(new Set(legacy).size === legacy.length, '2.0 reference legacy surfaces are duplicated.');
  for (const id of handoffIds) {
    assert(
      legacy.includes(id) || retired.includes(id),
      `1.0 surface ${id} is neither legacy nor replaced by an approved surface.`,
    );
  }
  return { approved: [...manifest.approved], legacy, retired };
}

/**
 * Headings of a Markdown file keyed by the same slug rule as scripts/docs-contract-check-core.mjs,
 * each with the text up to the next heading of the same or a higher level.
 */
function headingSections(source) {
  const sections = new Map();
  const counts = new Map();
  const lines = source.split(/\r?\n/u);
  const headings = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) return;
    const base = match[2].trim().toLocaleLowerCase('en-US')
      .replace(/[`*_~]/gu, '').replace(/[^\p{Letter}\p{Number}\s-]/gu, '').replace(/\s+/gu, '-').replace(/-+/gu, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.push({ slug: count === 0 ? base : `${base}-${count}`, level: match[1].length, index });
  });
  headings.forEach((heading, position) => {
    const next = headings.slice(position + 1).find((item) => item.level <= heading.level);
    sections.set(heading.slug, lines.slice(heading.index + 1, next ? next.index : lines.length).join('\n'));
  });
  return sections;
}

/** A calendar date that exists, written YYYY-MM-DD. */
function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value ?? '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The approval record must hold the user's answer for this surface: a table row in the anchored
 * section that names the surface id and whose last cell (the answer) is filled in.
 */
function assertDecisionRecorded(entry, approvalSource) {
  const anchor = entry.approval.record.split('#')[1];
  const section = anchor ? headingSections(approvalSource).get(anchor) : undefined;
  assert(section !== undefined, `Approved surface ${entry.id}: approval record has no heading #${anchor}.`);
  const row = section.split('\n').find((line) => line.trim().startsWith('|') && !/^\|[\s|:-]+\|$/u.test(line.trim())
    && line.includes(entry.id));
  assert(row, `Approved surface ${entry.id}: approval record #${anchor} has no row for ${entry.id}.`);
  const answer = row.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim()).at(-1) ?? '';
  assert(answer.length > 0 && !/^(?:-|—|tbd|todo|\?)$/iu.test(answer), `Approved surface ${entry.id}: approval record #${anchor} has no recorded answer.`);
}

/**
 * The approved story must be one literal case of `designReferenceCases`, and that list must be run by a
 * test loop that renders both locales, runs axe in each, takes the screenshot, moves keyboard focus both
 * ways, and resizes through the case's viewports without horizontal overflow.
 */
function validateApprovedVisualCase(entry, visualFile) {
  const cases = objectElements(arrayVariable(visualFile, 'designReferenceCases'), 'designReferenceCases');
  const matches = cases.filter((visualCase) => stringValue(propertyValue(visualCase, 'storyId')) === entry.visual.storyId);
  assert(matches.length === 1, `Approved surface ${entry.id}: designReferenceCases needs exactly one case for ${entry.visual.storyId}.`);
  const [visualCase] = matches;
  assert(stringValue(propertyValue(visualCase, 'screenshot')) === entry.visual.snapshot,
    `Approved surface ${entry.id}: its visual case does not render into ${entry.visual.snapshot}.`);
  const readySelector = stringValue(propertyValue(visualCase, 'readySelector'));
  assert(typeof readySelector === 'string' && readySelector.length > 0, `Approved surface ${entry.id}: its visual case needs a readySelector.`);
  const locale = stringValue(propertyValue(visualCase, 'locale'));
  assert(locale === 'ko' || locale === 'en', `Approved surface ${entry.id}: its visual case needs a supported locale.`);
  const viewports = propertyValue(visualCase, 'viewports');
  const sizes = viewports && ts.isArrayLiteralExpression(viewports) ? objectElements(viewports, `${entry.id} viewports`) : [];
  assert(sizes.length >= 2 && sizes.every((size) => numberValue(propertyValue(size, 'width')) && numberValue(propertyValue(size, 'height'))),
    `Approved surface ${entry.id}: its visual case needs at least two literal viewports.`);

  const loop = findForOf(visualFile, 'designReferenceCases');
  assert(loop, 'designReferenceCases must be executed by a for-of test loop.');
  const calls = callsWithin(loop);
  assert(calls.filter((call) => directCallName(call) === 'openStory').length >= 2, 'Each approved surface must render both its locale and the other one.');
  assert(calls.filter((call) => directCallName(call) === 'expectNoAccessibilityViolations').length >= 2, 'Each approved surface must run axe in both locales.');
  assert(calls.some((call) => methodCallName(call) === 'toHaveScreenshot'), 'Each approved surface must have a screenshot assertion.');
  assert(calls.some((call) => methodCallName(call) === 'setViewportSize'), 'Each approved surface must be checked at its viewports.');
  const strings = stringLiteralsWithin(loop);
  assert(strings.has('Tab') && strings.has('Shift+Tab'), 'Each approved surface must move keyboard focus forward and back.');
  const identifiers = identifiersWithin(loop);
  assert(identifiers.has('scrollWidth') && identifiers.has('innerWidth'), 'Each approved surface must assert that it has no horizontal overflow.');
}

/**
 * An approved surface must still be the thing the user approved: a real story
 * export (syntax tree, not text), an executed visual case with its axes, the
 * approved capture bytes, and the user's recorded answer.
 */
export function validateApprovedSurface(entry, { storySource, visualSource, availableSnapshots, captureBytes, captureSha256, approvalSource }) {
  const exports = exportedConstNames(parseTsx(storySource, entry.story.file));
  assert(exports.has(entry.story.export), `Approved surface ${entry.id}: story export ${entry.story.export} is missing.`);
  validateApprovedVisualCase(entry, parseTsx(visualSource, 'storybook.visual.spec.ts'));
  assert(
    availableSnapshots.has(entry.visual.snapshot),
    `Approved surface ${entry.id}: visual snapshot ${entry.visual.snapshot} is missing.`,
  );
  assertCanonicalPng(captureBytes, entry.capture.file);
  assert(
    captureSha256 === entry.capture.sha256,
    `Approved surface ${entry.id}: capture ${entry.capture.file} differs from the approved bytes.`,
  );
  assert(isCalendarDate(entry.approval.decidedAt), `Approved surface ${entry.id}: approval.decidedAt must be a real YYYY-MM-DD date.`);
  assertDecisionRecorded(entry, approvalSource);
}

/**
 * Validates that the handoff manifest names real Storybook exports and that
 * every promised matrix/accessibility axis is exercised by executable tests.
 */
export function validateDesktopHandoffContract({
  availableSnapshots,
  e2eSource,
  manifest,
  retiredSurfaceIds = [],
  storySource,
  visualSource,
}) {
  // The archived manifest itself is immutable and always complete.
  validateManifest(manifest);
  // A 1.0 surface replaced by an approved 2.0 surface retires its story and visual case.
  const retired = new Set(retiredSurfaceIds);
  const active = { ...manifest, surfaces: manifest.surfaces.filter((surface) => !retired.has(surface.id)) };
  validateStories(active, storySource);
  const visualFile = parseTsx(visualSource, 'storybook.visual.spec.ts');
  const retiredStoryIds = new Set(manifest.surfaces.filter((surface) => retired.has(surface.id)).map((surface) => surface.storyId));
  const canonicalSnapshots = validateCanonicalCases(
    active,
    visualFile,
    availableSnapshots,
    retiredStoryIds,
  );
  // Shell-wide axes stay guarded while any 1.0 surface is still the reference.
  if (active.surfaces.length > 0) {
    validateResponsiveAxes(visualFile);
    validateFixtureIntegrity(visualFile);
    validateReducedMotion(visualFile);
    validateElectronGeometryAndFocus(e2eSource);
  }
  return { canonicalSnapshots };
}
