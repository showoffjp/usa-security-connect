/**
 * AST codemod: await the data layer, now that it is async.
 *
 * Regex cannot do this safely - `await db.prepare(q).get().n` parses as
 * `await (db.prepare(q).get().n)`, which is `undefined`. Parsing properly lets
 * us wrap the exact call expression in `(await ...)` and mark the enclosing
 * function async.
 *
 * Handles both shapes in the codebase:
 *   inline   ->  db.prepare(`...`).get(x)
 *   hoisted  ->  const ins = db.prepare(`...`);  ins.run(x)
 */

import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import MagicString from 'magic-string';

const root = process.argv[2];
const DB_METHODS = new Set(['get', 'all', 'run']);

const files = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.js') && entry.name !== 'db.js') files.push(full);
  }
})(root);

/** Does this expression chain bottom out at `db.prepare(...)`? */
function rootsAtDbPrepare(node) {
  let cur = node;
  for (let i = 0; i < 12 && cur; i++) {
    if (cur.type === 'CallExpression') {
      const callee = cur.callee;
      if (
        callee?.type === 'MemberExpression' &&
        callee.property?.name === 'prepare' &&
        callee.object?.type === 'Identifier' &&
        callee.object.name === 'db'
      ) {
        return true;
      }
      cur = callee;
    } else if (cur.type === 'MemberExpression') {
      cur = cur.object;
    } else {
      return false;
    }
  }
  return false;
}

let totalCalls = 0;
let totalFns = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: 'module', locations: true });
  } catch (err) {
    console.error(`  ! parse failed ${path.relative(root, file)}: ${err.message}`);
    continue;
  }

  // Pass 1: identifiers assigned a prepared statement, so `ins.run()` is known.
  const handles = new Set();
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier' && node.init && rootsAtDbPrepare(node.init)) {
        // Only a bare `db.prepare(...)`, not a full chain that already calls .get()
        if (
          node.init.type === 'CallExpression' &&
          node.init.callee?.type === 'MemberExpression' &&
          node.init.callee.property?.name === 'prepare'
        ) {
          handles.add(node.id.name);
        }
      }
    },
  });

  // Pass 2: find the calls to await, and the functions that contain them.
  const magic = new MagicString(src);
  const targets = [];
  const fnsToMark = new Set();
  const ancestorsOf = new Map();

  walk.ancestor(ast, {
    CallExpression(node, _state, ancestors) {
      const callee = node.callee;
      if (callee?.type !== 'MemberExpression') return;
      const method = callee.property?.name;
      if (!DB_METHODS.has(method)) return;

      const onDb = rootsAtDbPrepare(callee.object);
      const onHandle = callee.object?.type === 'Identifier' && handles.has(callee.object.name);
      if (!onDb && !onHandle) return;

      // Already awaited?
      const parent = ancestors[ancestors.length - 2];
      if (parent?.type === 'AwaitExpression') return;

      targets.push(node);
      ancestorsOf.set(node, [...ancestors]);
    },
  });

  for (const node of targets) {
    magic.appendLeft(node.start, '(await ');
    magic.appendRight(node.end, ')');
    totalCalls += 1;

    // Mark the nearest enclosing function async.
    const ancestors = ancestorsOf.get(node) || [];
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
  }

  for (const fn of fnsToMark) {
    // `function foo()` / `async function foo()`; arrows start at their params.
    magic.appendLeft(fn.start, 'async ');
    totalFns += 1;
  }

  if (targets.length || fnsToMark.size) {
    fs.writeFileSync(file, magic.toString());
    console.log(
      `  ${path.relative(root, file).padEnd(28)} ${String(targets.length).padStart(3)} calls, ${fnsToMark.size} fn(s) -> async`
    );
  }
}

console.log(`\nawaited ${totalCalls} calls; marked ${totalFns} functions async`);
