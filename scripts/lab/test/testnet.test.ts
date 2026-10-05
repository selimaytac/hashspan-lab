import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testnet } from '../../../packages/common/src/testnets.js';
import { parseCommand } from '../commands.js';
import {
  checkRpcChain,
  chooseRpcUrl,
  chooseScenarios,
  prepareTestnetRun,
  readSavedSecret,
  saveSecret,
  scenarioEnv,
  scrub,
  type TestnetDeps,
  type TestnetOptions,
} from '../testnet.js';

// The key is generated at run time: gitleaks rejects key-shaped literals, and no test may depend on a real one.
const secret = generatePrivateKey();
const bare = secret.slice(2);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lab-testnet-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('chooseScenarios', () => {
  it('runs everything on Base Sepolia that has what it needs', () => {
    const result = chooseScenarios(testnet('base-sepolia'), ['all'], {});
    expect(result.run).toContain('treasury');
    expect(result.run).toContain('x402');
    expect(result.run).toContain('sealed-fees');
    expect(result.skipped.map((entry) => entry.name)).toEqual(['cdp']);
    expect(result.skipped[0]?.reason).toContain('CDP_API_KEY_ID');
  });

  it('runs cdp when the CDP values are given', () => {
    const env = { CDP_API_KEY_ID: 'a', CDP_API_KEY_SECRET: 'b', CDP_WALLET_SECRET: 'c' };
    expect(chooseScenarios(testnet('base-sepolia'), ['cdp'], env).run).toEqual(['cdp']);
  });

  it('skips the Base-only scenarios elsewhere, with the reason', () => {
    const result = chooseScenarios(testnet('sepolia'), ['treasury', 'paths', 'x402'], {});
    expect(result.run).toEqual(['treasury']);
    expect(result.skipped).toEqual([
      { name: 'paths', reason: 'runs on base-sepolia only' },
      { name: 'x402', reason: 'runs on base-sepolia only' },
    ]);
  });

  it('rejects an unknown scenario', () => {
    expect(() => chooseScenarios(testnet('sepolia'), ['nope'], {})).toThrow('unknown scenario');
  });
});

describe('checkRpcChain', () => {
  it('accepts the chosen testnet', () => {
    expect(() => checkRpcChain(testnet('op-sepolia'), 11155420)).not.toThrow();
  });

  it('refuses mainnets and unknown chains', () => {
    for (const id of [1, 8453, 10, 42161, 31337, 0]) {
      expect(() => checkRpcChain(testnet('base-sepolia'), id), String(id)).toThrow('refused');
    }
  });

  it('refuses an RPC that reports another testnet than the chosen one', () => {
    expect(() => checkRpcChain(testnet('base-sepolia'), 11155111)).toThrow(
      'Ethereum Sepolia (11155111), but Base Sepolia (84532) was chosen',
    );
  });
});

describe('chooseRpcUrl', () => {
  it('defaults to the public RPC and accepts http and https only', () => {
    const net = testnet('sepolia');
    expect(chooseRpcUrl(net, undefined)).toBe(net.env.defaultRpcUrl);
    expect(chooseRpcUrl(net, 'http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545');
    expect(() => chooseRpcUrl(net, 'ftp://x')).toThrow('http or https');
    expect(() => chooseRpcUrl(net, 'not a url')).toThrow('not a valid URL');
  });
});

describe('saved key file', () => {
  it('is written readable by its owner only and read back', () => {
    const file = join(dir, '.lab', 'testnet.env');
    saveSecret(file, secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '.lab')).mode & 0o777).toBe(0o700);
    expect(readSavedSecret(file)).toBe(secret);
  });

  it('is refused when others can read it, without echoing the content', () => {
    const file = join(dir, 'testnet.env');
    saveSecret(file, secret);
    chmodSync(file, 0o644);
    expect(() => readSavedSecret(file)).toThrow('can be read by others');
    try {
      readSavedSecret(file);
    } catch (error) {
      expect(String(error)).not.toContain(bare);
    }
  });

  it('is undefined without a file and an error for a broken one', () => {
    expect(readSavedSecret(join(dir, 'none.env'))).toBeUndefined();
    const file = join(dir, 'broken.env');
    writeFileSync(file, 'LAB_PRIVATE_KEY=hunter2\n', { mode: 0o600 });
    expect(() => readSavedSecret(file)).toThrow('64 hex digits');
    try {
      readSavedSecret(file);
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
    }
  });
});

describe('scrub', () => {
  it('replaces the secret with and without 0x, and every given secret', () => {
    const text = `a ${secret} b ${bare} c https://rpc.example/key123`;
    expect(scrub(text, [secret, 'https://rpc.example/key123'])).toBe(
      'a [redacted] b [redacted] c [redacted]',
    );
    expect(scrub('nothing', ['', secret])).toBe('nothing');
  });
});

const options = (overrides: Partial<TestnetOptions> = {}): TestnetOptions => ({
  chain: 'base-sepolia',
  scenarios: ['treasury'],
  rpc: undefined,
  save: false,
  yes: true,
  ...overrides,
});

function deps(overrides: Partial<TestnetDeps> = {}) {
  const lines: string[] = [];
  const calls = { prompt: 0, confirm: 0 };
  const value: TestnetDeps = {
    env: { LAB_PRIVATE_KEY: secret },
    savedFile: join(dir, '.lab', 'testnet.env'),
    chainId: async () => 84532,
    balance: async () => 10n ** 18n,
    promptSecret: async () => {
      calls.prompt++;
      return secret;
    },
    confirm: async () => {
      calls.confirm++;
      return true;
    },
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { value, lines, calls };
}

describe('prepareTestnetRun', () => {
  it('shows chain, account, balance and cost, and never the key', async () => {
    const { value, lines } = deps();
    const plan = await prepareTestnetRun(options(), value);
    expect(plan?.scenarios).toEqual(['treasury']);
    const shown = lines.join('\n');
    expect(shown).toContain('Base Sepolia (84532)');
    expect(shown).toContain(privateKeyToAccount(secret).address);
    expect(shown).toContain('1 ETH');
    expect(shown).toContain('estimate');
    expect(shown).not.toContain(bare);
  });

  it('labels a measured cost as measured', async () => {
    const { value, lines } = deps({ chainId: async () => 11155111 });
    await prepareTestnetRun(options({ chain: 'sepolia' }), value);
    expect(lines.join('\n')).toContain('measured');
  });

  it('refuses a mainnet RPC before it asks for or reads any key', async () => {
    const { value, calls } = deps({ env: {}, chainId: async () => 8453 });
    await expect(prepareTestnetRun(options(), value)).rejects.toThrow('refused');
    expect(calls.prompt).toBe(0);
  });

  it('refuses when the balance is below the cost, without the key in the message', async () => {
    const { value } = deps({ balance: async () => 1n });
    const error = await prepareTestnetRun(options(), value).catch((e: unknown) => e);
    expect(String(error)).toContain('below the cost');
    expect(String(error)).not.toContain(bare);
  });

  it('refuses a malformed key without echoing it', async () => {
    const { value } = deps({ env: {}, promptSecret: async () => 'hunter2-not-a-key' });
    const error = await prepareTestnetRun(options(), value).catch((e: unknown) => e);
    expect(String(error)).toContain('64 hex characters');
    expect(String(error)).not.toContain('hunter2');
  });

  it('asks for the key when there is none, and uses a saved one before asking', async () => {
    const asked = deps({ env: {} });
    await prepareTestnetRun(options(), asked.value);
    expect(asked.calls.prompt).toBe(1);

    saveSecret(asked.value.savedFile, secret);
    const saved = deps({ env: {}, savedFile: asked.value.savedFile });
    await prepareTestnetRun(options(), saved.value);
    expect(saved.calls.prompt).toBe(0);
  });

  it('sends nothing and saves nothing when the user declines', async () => {
    const { value } = deps({ confirm: async () => false });
    expect(await prepareTestnetRun(options({ yes: false, save: true }), value)).toBeUndefined();
    expect(readSavedSecret(value.savedFile)).toBeUndefined();
  });

  it('saves the key only with --save', async () => {
    const unsaved = deps();
    await prepareTestnetRun(options(), unsaved.value);
    expect(readSavedSecret(unsaved.value.savedFile)).toBeUndefined();

    const saved = deps();
    await prepareTestnetRun(options({ save: true }), saved.value);
    expect(readSavedSecret(saved.value.savedFile)).toBe(secret);
    expect(saved.lines.join('\n')).not.toContain(bare);
  });

  it('needs no key for a scenario that only reads', async () => {
    const { value, calls } = deps({ env: {} });
    const plan = await prepareTestnetRun(options({ scenarios: ['sealed-fees'] }), value);
    expect(plan?.secret).toBeUndefined();
    expect(calls.prompt).toBe(0);
  });

  it('fails when nothing can run', async () => {
    const { value } = deps({ chainId: async () => 11155111 });
    await expect(
      prepareTestnetRun(options({ chain: 'sepolia', scenarios: ['paths'] }), value),
    ).rejects.toThrow('no scenario can run');
  });
});

describe('scenarioEnv', () => {
  it("hands the key over under the testnet's own variable and drops LAB_PRIVATE_KEY", async () => {
    const { value } = deps({ chainId: async () => 11155111 });
    const plan = await prepareTestnetRun(options({ chain: 'sepolia' }), value);
    if (!plan) throw new Error('no plan');
    const env = scenarioEnv(
      plan,
      { LAB_PRIVATE_KEY: secret, PATH: '/bin', UNSET: undefined },
      'http://otlp',
    );
    expect(env).toMatchObject({
      LAB_TESTNET: 'sepolia',
      SEPOLIA_PRIVATE_KEY: secret,
      SEPOLIA_RPC_URL: plan.rpcUrl,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otlp',
      PATH: '/bin',
    });
    expect(env).not.toHaveProperty('LAB_PRIVATE_KEY');
    expect(env).not.toHaveProperty('UNSET');
  });
});

describe('parseCommand testnet', () => {
  it('defaults to the treasury scenario and takes a list', () => {
    expect(parseCommand(['testnet'])).toEqual({
      name: 'testnet',
      chain: undefined,
      scenarios: ['treasury'],
      rpc: undefined,
      save: false,
      yes: false,
    });
    expect(
      parseCommand([
        'testnet',
        '--chain',
        'op-sepolia',
        '--scenario',
        'treasury,eip7702',
        '--scenario',
        'soak',
        '--save',
        '--yes',
      ]),
    ).toMatchObject({
      chain: 'op-sepolia',
      scenarios: ['treasury', 'eip7702', 'soak'],
      save: true,
      yes: true,
    });
  });

  it('keeps its flags to itself', () => {
    expect(() => parseCommand(['up', '--chain', 'sepolia'])).toThrow('testnet command');
    expect(() => parseCommand(['run', 'paths', '--yes'])).toThrow('testnet command');
    expect(() => parseCommand(['testnet', '--skip-install'])).toThrow('up command');
  });
});
