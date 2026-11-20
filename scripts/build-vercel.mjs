import { cp, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const outputRoot = resolve(repoRoot, '.vercel', 'output');
const expectedOutputRoot = resolve(repoRoot, '.vercel', 'output');
const functionRoot = join(outputRoot, 'functions', 'index.func');
const appRoot = join(functionRoot, 'app');

if (outputRoot !== expectedOutputRoot || !outputRoot.startsWith(resolve(repoRoot, '.vercel'))) {
  throw new Error('Refusing to clean an unexpected Vercel output path.');
}

async function copyTreeByExtension(sourceRoot, destinationRoot, allowedExtensions) {
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyTreeByExtension(source, destination, allowedExtensions);
    } else if (allowedExtensions.has(extname(entry.name).toLowerCase())) {
      await copyFile(source, destination);
    }
  }
}

async function copyRootSources() {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const rootPattern = /\.(?:html|css|js|mjs)$/i;
  for (const entry of entries) {
    if (entry.isFile() && (rootPattern.test(entry.name) || entry.name === 'site.json' || entry.name === 'package.json')) {
      await copyFile(join(repoRoot, entry.name), join(appRoot, entry.name));
    }
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(appRoot, { recursive: true });
await copyRootSources();
await cp(join(repoRoot, 'assets'), join(appRoot, 'assets'), { recursive: true });
await copyTreeByExtension(join(repoRoot, 'lib'), join(appRoot, 'lib'), new Set(['.mjs']));
await copyTreeByExtension(join(repoRoot, 'data'), join(appRoot, 'data'), new Set(['.json']));
await cp(join(repoRoot, 'node_modules'), join(appRoot, 'node_modules'), { recursive: true });
await copyFile(join(repoRoot, 'vercel', 'handler.mjs'), join(functionRoot, 'handler.mjs'));

const config = { version: 3, routes: [{ src: '/(.*)', dest: '/index' }] };
const functionConfig = { runtime: 'nodejs24.x', handler: 'handler.mjs', launcherType: 'Nodejs', shouldAddHelpers: false };
await writeFile(join(outputRoot, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
await writeFile(join(functionRoot, '.vc-config.json'), `${JSON.stringify(functionConfig, null, 2)}\n`);
console.log(`Built ${join('.vercel', 'output')}`);
