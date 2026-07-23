#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const [, , nextVersion] = process.argv;

if (!nextVersion) {
  console.error('Usage: node scripts/set-version.mjs <version>');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(nextVersion)) {
  console.error(`Invalid version: ${nextVersion}`);
  process.exit(1);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  {
    filePath: path.join(projectRoot, 'package.json'),
    search: /"version":\s*"[^"]+"/u,
    replace: `"version": "${nextVersion}"`,
  },
  {
    filePath: path.join(projectRoot, '.claude-plugin', 'plugin.json'),
    search: /"version":\s*"[^"]+"/u,
    replace: `"version": "${nextVersion}"`,
  },
  {
    filePath: path.join(projectRoot, 'src', 'config.ts'),
    search: /const PLUGIN_VERSION = '[^']+'/u,
    replace: `const PLUGIN_VERSION = '${nextVersion}'`,
  },
  {
    // The plugin entry inside the self-referencing marketplace manifest. Its
    // `version` participates in Claude Code's update check, so it must move
    // with the plugin. (The marketplace's own metadata.version is independent
    // and left alone.)
    filePath: path.join(projectRoot, '.claude-plugin', 'marketplace.json'),
    search: /("plugins":[\s\S]*?)"version":\s*"[^"]+"/u,
    replace: `$1"version": "${nextVersion}"`,
  },
];

for (const target of targets) {
  const current = fs.readFileSync(target.filePath, 'utf8');
  const matched = target.search.test(current);
  const updated = current.replace(target.search, target.replace);

  if (!matched) {
    console.error(`Version placeholder not found in ${target.filePath}`);
    process.exit(1);
  }

  fs.writeFileSync(target.filePath, updated, 'utf8');
  console.log(`Updated ${path.relative(projectRoot, target.filePath)} -> ${nextVersion}`);
}
