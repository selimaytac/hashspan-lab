import type { Hex } from 'viem';

/** Runtime bytecode that stores `payload` (at most 255 bytes) in memory and reverts with it, whatever it is called with. */
export function revertingWith(payload: Hex): Hex {
  const bytes = payload.slice(2);
  const size = bytes.length / 2;
  if (size > 0xff) throw new Error('revert data too long');
  let code = '';
  for (let offset = 0; offset < size; offset += 32) {
    const word = bytes.slice(offset * 2, offset * 2 + 64).padEnd(64, '0');
    // PUSH32 word, PUSH1 offset, MSTORE
    code += `7f${word}60${offset.toString(16).padStart(2, '0')}52`;
  }
  // PUSH1 size, PUSH1 0, REVERT
  return `0x${code}60${size.toString(16).padStart(2, '0')}6000fd`;
}

/** Creation bytecode that deploys `runtime` (at most 255 bytes) as the contract's code. */
export function deployCode(runtime: Hex): Hex {
  const size = (runtime.length - 2) / 2;
  if (size > 0xff) throw new Error('runtime code too long');
  // PUSH1 size, DUP1, PUSH1 11, PUSH1 0, CODECOPY, PUSH1 0, RETURN: copies the code after these 11 bytes and returns it.
  return `0x60${size.toString(16).padStart(2, '0')}80600b6000396000f3${runtime.slice(2)}`;
}
