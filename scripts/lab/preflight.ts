import { createServer } from 'node:net';

/** The stack's host ports (stack/compose.yaml): Grafana, collector gRPC and HTTP, Prometheus, Tempo. */
export const PORTS = [13000, 14317, 14318, 19090, 13200] as const;

/** Free disk the first `up` needs: the stack's images, node_modules, Anvil and the Docker layers. */
export const MIN_FREE_BYTES = 6 * 1024 ** 3;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when the check fails. */
  fix?: string | undefined;
}

/** The running Node.js must have the major version of `.nvmrc` (24, or v24.1.0). */
export function nodeCheck(nvmrc: string, running: string): Check {
  const wanted = Number(nvmrc.trim().replace(/^v/, '').split('.')[0]);
  const actual = Number(running.replace(/^v/, '').split('.')[0]);
  const ok = Number.isInteger(wanted) && actual === wanted;
  return {
    name: 'Node.js',
    ok,
    detail: `running ${running}, .nvmrc wants ${nvmrc.trim()}`,
    fix: ok
      ? undefined
      : 'run `nvm use` in this directory (or install the version of .nvmrc), then try again',
  };
}

export function diskCheck(freeBytes: number, needBytes = MIN_FREE_BYTES): Check {
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const ok = freeBytes >= needBytes;
  return {
    name: 'Free disk',
    ok,
    detail: `${gib(freeBytes)} GiB free, ${gib(needBytes)} GiB needed`,
    fix: ok ? undefined : 'free some disk space, or `pnpm lab nuke` if an old lab is still around',
  };
}

export function dockerCheck(exitCode: number | null): Check {
  const ok = exitCode === 0;
  return {
    name: 'Docker',
    ok,
    detail: ok ? 'daemon answers' : 'the daemon does not answer',
    fix: ok
      ? undefined
      : 'start Docker Desktop (or the Docker service) and wait until `docker info` works',
  };
}

export function pnpmCheck(exitCode: number | null): Check {
  const ok = exitCode === 0;
  return {
    name: 'pnpm',
    ok,
    detail: ok ? 'found' : 'not found',
    fix: ok ? undefined : 'run `corepack enable pnpm`',
  };
}

/** True when nothing listens on the port of the loopback interface. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function portsCheck(ports: readonly number[], free = portFree): Promise<Check> {
  const busy: number[] = [];
  for (const port of ports) if (!(await free(port))) busy.push(port);
  const ok = busy.length === 0;
  return {
    name: 'Ports',
    ok,
    detail: ok ? `${ports.join(', ')} are free` : `in use: ${busy.join(', ')}`,
    fix: ok
      ? undefined
      : 'stop whatever listens on them (`lsof -i :<port>` shows what); the lab keeps to these ports so that it can run beside other local OTLP backends',
  };
}

export function formatChecks(checks: readonly Check[]): string {
  return checks
    .map((check) => {
      const line = `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`;
      return check.ok || !check.fix ? line : `${line}\n     -> ${check.fix}`;
    })
    .join('\n');
}
