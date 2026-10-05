import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { grafanaLinks, LOCAL_SCENARIOS, parseCommand } from '../commands.js';
import { connectOutput } from '../connect.js';
import {
  diskCheck,
  dockerCheck,
  formatChecks,
  nodeCheck,
  portFree,
  portsCheck,
} from '../preflight.js';

describe('parseCommand', () => {
  it('parses the commands', () => {
    expect(parseCommand(['up'])).toEqual({ name: 'up', skipInstall: false });
    expect(parseCommand(['up', '--skip-install'])).toEqual({ name: 'up', skipInstall: true });
    expect(parseCommand(['down'])).toEqual({ name: 'down' });
    expect(parseCommand(['nuke'])).toEqual({ name: 'nuke' });
    expect(parseCommand(['status'])).toEqual({ name: 'status' });
    expect(parseCommand(['connect'])).toEqual({ name: 'connect' });
    expect(parseCommand(['run', 'paths'])).toEqual({ name: 'run', scenario: 'paths' });
  });

  it('shows the help without a command or with --help', () => {
    expect(parseCommand([])).toEqual({ name: 'help' });
    expect(parseCommand(['--help'])).toEqual({ name: 'help' });
  });

  it('rejects unknown commands, scenarios and stray arguments', () => {
    expect(() => parseCommand(['dance'])).toThrow('unknown command dance');
    expect(() => parseCommand(['run'])).toThrow('one scenario');
    expect(() => parseCommand(['run', 'paths', 'x'])).toThrow('one scenario');
    expect(() => parseCommand(['run', 'sealed-fees'])).toThrow('unknown scenario');
    expect(() => parseCommand(['down', 'now'])).toThrow('no argument');
    expect(() => parseCommand(['up', '--nope'])).toThrow();
  });

  it('keeps the scenarios the lab runs locally', () => {
    expect(LOCAL_SCENARIOS).not.toContain('sealed-fees');
    expect(LOCAL_SCENARIOS).not.toContain('soak');
    expect(LOCAL_SCENARIOS[0]).toBe('treasury');
  });
});

describe('preflight', () => {
  it('compares the Node.js major version with .nvmrc', () => {
    expect(nodeCheck('24\n', 'v24.9.0').ok).toBe(true);
    expect(nodeCheck('v24.1.0', 'v24.9.0').ok).toBe(true);
    const wrong = nodeCheck('24', 'v22.12.0');
    expect(wrong.ok).toBe(false);
    expect(wrong.fix).toContain('nvm use');
  });

  it('checks the free disk', () => {
    expect(diskCheck(10 * 1024 ** 3).ok).toBe(true);
    const low = diskCheck(1024 ** 3);
    expect(low.ok).toBe(false);
    expect(low.detail).toBe('1.0 GiB free, 6.0 GiB needed');
  });

  it('checks Docker by the exit code of `docker info`', () => {
    expect(dockerCheck(0).ok).toBe(true);
    expect(dockerCheck(1).fix).toContain('Docker');
    expect(dockerCheck(null).ok).toBe(false);
  });

  it('finds a port that is in use', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await portFree(port)).toBe(false);
      const check = await portsCheck([port]);
      expect(check.ok).toBe(false);
      expect(check.detail).toBe(`in use: ${port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await portFree(port)).toBe(true);
  });

  it('prints what to do under each failed check only', () => {
    const text = formatChecks([nodeCheck('24', 'v24.0.0'), dockerCheck(1)]);
    expect(text).toContain('ok   Node.js');
    expect(text).toContain('FAIL Docker');
    expect(text.match(/->/g)).toHaveLength(1);
  });
});

describe('grafanaLinks', () => {
  it('links every dashboard and a trace', () => {
    const links = grafanaLinks([{ uid: 'hashspan-lab-fees', title: 'Fees' }], 'abc123');
    expect(links.dashboards).toEqual([
      { title: 'Fees', url: 'http://127.0.0.1:13000/d/hashspan-lab-fees' },
    ]);
    expect(links.trace).toContain('/explore?');
    expect(links.traceJson).toBe('http://127.0.0.1:13200/api/traces/abc123');
    expect(decodeURIComponent(links.trace ?? '')).toContain('"query":"abc123"');
  });

  it('has no trace link without a trace', () => {
    expect(grafanaLinks([], undefined).trace).toBeUndefined();
    expect(grafanaLinks([], undefined).traceJson).toBeUndefined();
  });
});

describe('connectOutput', () => {
  it('prints the endpoint, the protocol and a service name, and links to hashspan', () => {
    const text = connectOutput(true);
    expect(text).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318');
    expect(text).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
    expect(text).toContain('OTEL_SERVICE_NAME=my-agent');
    expect(text).toContain('https://github.com/selimaytac/hashspan#readme');
    expect(text).toContain('The lab stack is up');
  });

  it('says how to start the stack when it is down', () => {
    expect(connectOutput(false)).toContain('pnpm lab up');
  });
});
