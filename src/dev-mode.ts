/**
 * Inngest dev mode provider.
 *
 * Compiles a workflow to an Inngest function, generates a local dev server
 * entry (express or hono), and watches for file changes.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { glob } from 'glob';
import { spawn, type ChildProcess } from 'child_process';
import { compileCustomTarget, logger, getErrorMessage } from '@synergenius/flow-weaver/cli';
import type { DevModeOptions } from '@synergenius/flow-weaver/api';

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function cycleSeparator(file?: string): void {
  const ts = timestamp();
  const pad = '─'.repeat(40);
  logger.log(`\n  ${logger.dim(`─── ${ts} ${pad}`)}`);
  if (file) {
    logger.log(`  ${logger.dim('File changed:')} ${path.basename(file)}`);
  }
}

function checkDependency(pkg: string, cwd: string): boolean {
  try {
    require.resolve(pkg, { paths: [cwd] });
    return true;
  } catch {
    return false;
  }
}

function generateDevServerEntry(
  inngestOutputPath: string,
  framework: string,
  port: number
): string {
  const relImport = `./${path.basename(inngestOutputPath).replace(/\.ts$/, '.js')}`;

  if (framework === 'express') {
    return `import express from 'express';
import { handler } from '${relImport}';

const app = express();
app.use(express.json());
app.use('/api/inngest', handler);
app.listen(${port}, () => {
  console.log('Inngest dev server running on http://localhost:${port}');
  console.log('Inngest endpoint: http://localhost:${port}/api/inngest');
  console.log('');
  console.log('Connect Inngest Dev Server:');
  console.log('  npx inngest-cli@latest dev -u http://localhost:${port}/api/inngest');
});
`;
  }

  if (framework === 'hono') {
    return `import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { handler } from '${relImport}';

const app = new Hono();
app.route('/api/inngest', handler);

serve({ fetch: app.fetch, port: ${port} }, () => {
  console.log('Inngest dev server running on http://localhost:${port}');
  console.log('Inngest endpoint: http://localhost:${port}/api/inngest');
  console.log('');
  console.log('Connect Inngest Dev Server:');
  console.log('  npx inngest-cli@latest dev -u http://localhost:${port}/api/inngest');
});
`;
  }

  // Default: express
  return generateDevServerEntry(inngestOutputPath, 'express', port);
}

export async function runInngestDevMode(
  filePath: string,
  options: DevModeOptions
): Promise<void> {
  const framework = options.framework ?? 'express';
  const port = options.port ?? 3000;
  const cwd = path.dirname(filePath);

  // Check dependencies
  const missingDeps: string[] = [];
  if (!checkDependency('inngest', cwd)) missingDeps.push('inngest');
  if (framework === 'express' && !checkDependency('express', cwd)) missingDeps.push('express');
  if (framework === 'hono') {
    if (!checkDependency('hono', cwd)) missingDeps.push('hono');
    if (!checkDependency('@hono/node-server', cwd)) missingDeps.push('@hono/node-server');
  }

  if (missingDeps.length > 0) {
    throw new Error(`Missing dependencies: ${missingDeps.join(', ')}. Install them with: npm install ${missingDeps.join(' ')}`);
  }

  // Set up temp directory for generated files
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-inngest-dev-'));
  const inngestOutputPath = path.join(tmpDir, path.basename(filePath).replace(/\.ts$/, '.inngest.ts'));

  let serverProcess: ChildProcess | null = null;

  const compileInngest = async (): Promise<boolean> => {
    try {
      await compileCustomTarget('inngest', filePath, {
        production: false,
        workflowName: options.workflow,
        serve: true,
        framework: framework as 'next' | 'express' | 'hono' | 'fastify' | 'remix',
        typedEvents: true,
      });

      // compileCustomTarget writes to filePath.replace(.ts, .inngest.ts)
      // Copy it to our temp dir, then remove the source-adjacent file
      const sourceOutput = filePath.replace(/\.ts$/, '.inngest.ts');
      if (fs.existsSync(sourceOutput)) {
        fs.copyFileSync(sourceOutput, inngestOutputPath);
        try { fs.unlinkSync(sourceOutput); } catch { /* ignore */ }
      }
      return true;
    } catch (error) {
      logger.error(`Compilation failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  const startServer = (): void => {
    const entryPath = path.join(tmpDir, 'dev-server.ts');
    const entryCode = generateDevServerEntry(inngestOutputPath, framework, port);
    fs.writeFileSync(entryPath, entryCode, 'utf8');

    serverProcess = spawn('npx', ['tsx', entryPath], {
      cwd: path.dirname(filePath),
      stdio: 'inherit',
      shell: true,
    });

    serverProcess.on('error', (err) => {
      logger.error(`Server process error: ${err.message}`);
    });

    serverProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        logger.error(`Server exited with code ${code}`);
      }
      serverProcess = null;
    });
  };

  const stopServer = (): void => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
      serverProcess = null;
    }
  };

  const restartServer = async (): Promise<void> => {
    stopServer();
    const ok = await compileInngest();
    if (ok) {
      startServer();
    }
  };

  // Header
  logger.section('Inngest Dev Mode');
  logger.info(`File: ${path.basename(filePath)}`);
  logger.info(`Framework: ${framework}`);
  logger.info(`Port: ${port}`);
  logger.newline();

  // Initial compile + start
  const ok = await compileInngest();
  if (!ok) {
    if (options.once) return;
    logger.info('Fix the errors above, then save the file to retry.');
  } else {
    if (options.once) return;
    startServer();
  }

  // Watch for changes
  logger.newline();
  logger.success('Watching for file changes... (Ctrl+C to stop)');

  const files = await glob(path.resolve(filePath), { absolute: true });
  const chokidar = await import('chokidar');
  const watcher = chokidar.watch(files, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('change', async (file) => {
    cycleSeparator(file);
    logger.info('Recompiling and restarting server...');
    await restartServer();
  });

  // Cleanup
  const sourceOutput = filePath.replace(/\.ts$/, '.inngest.ts');
  const cleanup = () => {
    logger.newline();
    logger.info('Stopping dev mode...');
    stopServer();
    watcher.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.unlinkSync(sourceOutput); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  if (process.platform !== 'win32') process.on('SIGTERM', cleanup);

  // Keep process alive
  await new Promise(() => {});
}
