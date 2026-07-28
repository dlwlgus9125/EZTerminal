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

function validateCanonicalCases(manifest, sourceFile, availableSnapshots) {
  assert(
    availableSnapshots instanceof Set,
    'Desktop handoff guard requires the availableSnapshots file set.',
  );
  const cases = objectElements(
    arrayVariable(sourceFile, 'desktopHandoffCases'),
    'desktopHandoffCases',
  );
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

/**
 * Validates that the handoff manifest names real Storybook exports and that
 * every promised matrix/accessibility axis is exercised by executable tests.
 */
export function validateDesktopHandoffContract({
  availableSnapshots,
  e2eSource,
  manifest,
  storySource,
  visualSource,
}) {
  validateManifest(manifest);
  validateStories(manifest, storySource);
  const visualFile = parseTsx(visualSource, 'storybook.visual.spec.ts');
  const canonicalSnapshots = validateCanonicalCases(
    manifest,
    visualFile,
    availableSnapshots,
  );
  validateResponsiveAxes(visualFile);
  validateFixtureIntegrity(visualFile);
  validateReducedMotion(visualFile);
  validateElectronGeometryAndFocus(e2eSource);
  return { canonicalSnapshots };
}
