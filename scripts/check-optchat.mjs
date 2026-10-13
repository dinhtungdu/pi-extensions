import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
const host = join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
const temp = await mkdtemp(join(tmpdir(), 'check-optchat-'));
try {
  const paths = Object.fromEntries(['pi-agent-core', 'pi-ai', 'pi-coding-agent', 'pi-tui'].map(name => {
    const pkg = `@earendil-works/${name}`;
    const directory = name === 'pi-coding-agent' ? host : join(host, 'node_modules', pkg);
    return [pkg, [join(directory, name === 'pi-ai' ? 'dist/compat.d.ts' : 'dist/index.d.ts')]];
  }));
  paths.typebox = [join(root, 'node_modules/typebox/build/index.d.mts')];
  const config = { compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, types: ['node'], typeRoots: [join(root, 'node_modules/@types')], paths }, files: [join(root, 'packages/optchat/src/index.ts'), join(root, 'scripts/fixtures/optchat-provider.ts')] };
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify(config));
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(temp, 'tsconfig.json')], { stdio: 'inherit' });
  console.log('OptChat fork source typecheck passed against the installed Pi host.');
} finally { await rm(temp, { recursive: true, force: true }); }
