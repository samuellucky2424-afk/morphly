const fs = require('fs');
const path = require('path');

const root = __dirname ? path.resolve(__dirname, '..') : process.cwd();
const pathsToRemove = ['dist', 'release'];

for (const relativePath of pathsToRemove) {
  fs.rmSync(path.join(root, relativePath), { recursive: true, force: true });
}
