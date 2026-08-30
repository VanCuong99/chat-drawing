import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const projectRoot = process.cwd();
const webRoot = path.join(projectRoot, 'apps/web');
const messagesPath = path.join(webRoot, 'src/i18n/messages.ts');

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') return [];
      return sourceFiles(entryPath);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

function parse(filePath, text) {
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function literalTranslationKeys(sourceFile) {
  const keys = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 't'
      && node.arguments.length
      && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
      keys.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

function dictionaryKeys(sourceFile) {
  const keys = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'viMessages'
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !property.name) continue;
        if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) keys.add(property.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

const messageSource = await readFile(messagesPath, 'utf8');
const translations = dictionaryKeys(parse(messagesPath, messageSource));
const used = new Set();
for (const filePath of await sourceFiles(webRoot)) {
  if (filePath === messagesPath) continue;
  const source = parse(filePath, await readFile(filePath, 'utf8'));
  for (const key of literalTranslationKeys(source)) used.add(key);
}

const missing = [...used].filter((key) => !translations.has(key)).sort();
if (missing.length) {
  console.error(`Missing ${missing.length} Vietnamese translation(s):`);
  for (const key of missing) console.error(`- ${key}`);
  process.exitCode = 1;
} else {
  console.log(`i18n coverage OK: ${used.size} English source strings have Vietnamese translations.`);
}
