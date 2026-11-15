'use strict';

// Used by the automatic build on GitHub, after make-components.js: adds the packages that come in
// the AI download (build-exclude.json) to the installer's list of things to leave out.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const exclude = JSON.parse(fs.readFileSync(path.join(root, 'build-exclude.json'), 'utf8'));
const rules = exclude.map((p) => `!node_modules/${p}/**`);
pkg.build.files = [...new Set([...pkg.build.files, ...rules])];
pkg.build.asarUnpack = (pkg.build.asarUnpack || []).filter((g) => !exclude.some((p) => g.startsWith(`node_modules/${p}/`) || g === `node_modules/${p}/**`));
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`The installer leaves out ${exclude.length} packages:\n  ${rules.join('\n  ')}`);
