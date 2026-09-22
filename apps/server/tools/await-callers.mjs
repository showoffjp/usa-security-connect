/**
 * Second codemod pass: await calls to the functions the first pass made async.
 *
 * Making a function async changes its contract for every caller, and missing
 * one is silent - the caller gets a Promise and reads `undefined` off it. This
 * finds them all by parsing rather than grepping.
 *
 * Run repeatedly: each pass can make more functions async (a caller that now
 * awaits must itself be async), so it iterates until nothing changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import MagicString from 'magic-string';

const root = process.argv[2];

/** Names that are async but must NOT be awaited at call sites. */
const SKIP = new Set([
  'requireAuth', // Express middleware - handled explicitly, see lib/auth.js
  'wrap',
  'pushAsync', // deliberately fire-and-forget
]);

const files = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(root);

const parse = (src) => acorn.parse(src, { ecmaVersion: 2023, sourceType: 'module' });

/** Every async function name declared across the project. */
function collectAsyncNames() {
  const names = new Set();
  for (const file of files) {
    let ast;
    try {
      ast = parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    walk.simple(ast, {
      FunctionDeclaration(node) {
        if (node.async && node.id?.name) names.add(node.id.name);
      },
      VariableDeclarator(node) {
        if (
          node.id?.type === 'Identifier' &&
          (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression') &&
          node.init.async
        ) {
          names.add(node.id.name);
        }
      },
    });
  }
  for (const skip of SKIP) names.delete(skip);
  return names;
}

let round = 0;
let changedAnything = true;

while (changedAnything && round < 6) {
  round += 1;
  changedAnything = false;
  const asyncNames = collectAsyncNames();

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parse(src);
    } catch (err) {
      console.error(`  ! parse failed ${path.relative(root, file)}: ${err.message}`);
      continue;
    }

    const magic = new MagicString(src);
    const fnsToMark = new Set();
    let calls = 0;

    walk.ancestor(ast, {
      CallExpression(node, _state, ancestors) {
        // Only bare identifier calls: `sweep()`, not `obj.sweep()`.
        if (node.callee?.type !== 'Identifier') return;
        if (!asyncNames.has(node.callee.name)) return;

        const parent = ancestors[ancestors.length - 2];
        if (parent?.type === 'AwaitExpression') return;
        // `return fn()` inside a non-async fn is fine; awaiting is still safe.
        if (parent?.type === 'ArrowFunctionExpression' && parent.body === node) return;

        magic.appendLeft(node.start, 'await ');
        calls += 1;

        for (let i = ancestors.length - 1; i >= 0; i--) {
          const fn = ancestors[i];
          if (
            fn.type === 'FunctionDeclaration' ||
            fn.type === 'FunctionExpression' ||
            fn.type === 'ArrowFunctionExpression'
          ) {
            if (!fn.async) fnsToMark.add(fn);
            break;
          }
        }
      },
    });

    for (const fn of fnsToMark) magic.appendLeft(fn.start, 'async ');

    if (calls || fnsToMark.size) {
      fs.writeFileSync(file, magic.toString());
      console.log(
        `  round ${round}  ${path.relative(root, file).padEnd(26)} ${String(calls).padStart(3)} calls, ${fnsToMark.size} fn(s) -> async`
      );
      changedAnything = true;
    }
  }
}

console.log(`\nsettled after ${round} round(s)`);
