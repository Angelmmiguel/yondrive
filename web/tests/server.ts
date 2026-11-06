/**
 * A throwaway Go server for the end-to-end tests: built once per process from
 * the repository, started on a free loopback port over a fresh temporary data
 * directory, and removed together with it. Needs `go` on PATH, which the
 * flake's shell provides, and the web app built into web/build for the
 * browser specs. YONDRIVE_E2E names an already running server to use instead.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Server {
	url: string;
	stop: () => Promise<void>;
}

const repo = fileURLToPath(new URL('../..', import.meta.url));
let binary: Promise<string> | null = null;

function build(): Promise<string> {
	binary ??= (async () => {
		const dir = await mkdtemp(join(tmpdir(), 'yondrive-e2e-'));
		const out = join(dir, 'yondrive');
		await run('go', ['build', '-o', out, './cmd/yondrive'], repo);
		return out;
	})();
	return binary;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
		);
	});
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('no port assigned'));
				return;
			}
			probe.close(() => resolve(address.port));
		});
	});
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
		try {
			const res = await fetch(`${url}/api/v1/health`);
			if (res.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`server at ${url} did not become healthy`);
}

/** Starts a fresh server, or points at YONDRIVE_E2E when set. */
export async function startServer(): Promise<Server> {
	const external = process.env.YONDRIVE_E2E;
	if (external !== undefined && external !== '') {
		return { url: external, stop: () => Promise.resolve() };
	}
	const bin = await build();
	const data = await mkdtemp(join(tmpdir(), 'yondrive-e2e-data-'));
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const child = spawn(bin, ['serve', '--addr', `127.0.0.1:${port}`, '--data', data], {
		stdio: ['ignore', 'ignore', 'ignore']
	});
	const stop = async (): Promise<void> => {
		if (child.exitCode === null) {
			const exited = new Promise((r) => child.once('exit', r));
			child.kill('SIGTERM');
			await exited;
		}
		await rm(data, { recursive: true, force: true });
	};
	try {
		await waitForHealth(url, child);
	} catch (e) {
		await stop();
		throw e;
	}
	return { url, stop };
}
