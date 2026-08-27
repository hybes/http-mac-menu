import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'http-widgets-css-'));
const generated = join(directory, 'output.css');

try {
  const cli = join(
    root,
    'node_modules',
    '@tailwindcss',
    'cli',
    'dist',
    'index.mjs'
  );
  const result = spawnSync(
    process.execPath,
    [cli, '-i', 'styles.css', '-o', generated, '--minify'],
    { cwd: root, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exitCode = result.status || 1;
  } else {
    const [expected, current] = await Promise.all([
      readFile(generated),
      readFile(join(root, 'ui', 'output.css')),
    ]);
    if (!expected.equals(current)) {
      console.error(
        'ui/output.css is stale. Run `npm run build:css` and include the result.'
      );
      process.exitCode = 1;
    } else {
      console.log('ui/output.css matches styles.css and tokens.css.');
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
