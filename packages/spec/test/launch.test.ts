import { describe, expect, it } from 'vitest';
import { MCP_ROOT_FLAG, rootArgOf, withoutRootArgs, withRootArg } from '../src/index.js';

/**
 * mcp-1: the MCP server's `--root` argv grammar lives here once. The server's
 * parseServerArgs, the skills installer (withProjectRoot) and the CLI's
 * isDefaultMcpCommand / mcpPortabilityNote all read it through these helpers.
 */

/** Every arg list up to `max` long over tokens that exercise the grammar. */
function argLists(max: number): string[][] {
  const tokens = ['--root', '-r', '--root=', '--root=/a', '/b', 'login', '-h', 'x', ''];
  const out: string[][] = [[]];
  let layer: string[][] = [[]];
  for (let n = 0; n < max; n++) {
    layer = layer.flatMap((l) => tokens.map((t) => [...l, t]));
    out.push(...layer);
  }
  return out;
}

describe('rootArgOf', () => {
  it('reads --root <dir>, -r <dir> and --root=<dir>', () => {
    expect(rootArgOf(['--root', '/p'])).toBe('/p');
    expect(rootArgOf(['-r', '/p'])).toBe('/p');
    expect(rootArgOf(['--root=/p'])).toBe('/p');
    expect(rootArgOf(['-y', 'factstack-mcp', '--root', 'D:\\my project'])).toBe('D:\\my project');
  });

  it('the last root wins, in any spelling', () => {
    expect(rootArgOf(['--root', 'a', '--root=b'])).toBe('b');
    expect(rootArgOf(['--root=a', '-r', 'b'])).toBe('b');
    expect(rootArgOf(['-r', 'a', '--root', 'b', '--root=c'])).toBe('c');
  });

  it('the flag takes the next arg even when it looks like a flag or sub-command', () => {
    expect(rootArgOf(['--root', 'login'])).toBe('login');
    expect(rootArgOf(['--root', '--help'])).toBe('--help');
    expect(rootArgOf(['-r', '--root'])).toBe('--root');
    expect(rootArgOf(['--root', '--root', 'x'])).toBe('--root'); // x is not a root
  });

  it('names no root: none given, a trailing flag, or an empty value', () => {
    expect(rootArgOf([])).toBeUndefined();
    expect(rootArgOf(['login', '-h'])).toBeUndefined();
    expect(rootArgOf(['--root'])).toBeUndefined();
    expect(rootArgOf(['-r'])).toBeUndefined();
    expect(rootArgOf(['--root='])).toBeUndefined();
    expect(rootArgOf(['--root', ''])).toBeUndefined();
    // An empty last value clears an earlier root.
    expect(rootArgOf(['--root', '/x', '--root='])).toBeUndefined();
    // A trailing flag does not: it has no value to set.
    expect(rootArgOf(['--root', '/x', '--root'])).toBe('/x');
  });

  it('reads only these spellings', () => {
    expect(rootArgOf(['-r=/p'])).toBeUndefined();
    expect(rootArgOf(['--rootdir', '/p'])).toBeUndefined();
    expect(rootArgOf(['--ROOT', '/p'])).toBeUndefined();
    expect(rootArgOf(['.'])).toBeUndefined(); // a positional is not a root
  });
});

describe('withoutRootArgs', () => {
  it('drops every root spelling with its value and keeps the rest in order', () => {
    expect(withoutRootArgs(['-y', 'factstack-mcp', '--root', '/p'])).toEqual([
      '-y',
      'factstack-mcp',
    ]);
    expect(withoutRootArgs(['a', '-r', '/p', 'b', '--root=/q', 'c'])).toEqual(['a', 'b', 'c']);
    expect(withoutRootArgs(['--root', 'login', 'login'])).toEqual(['login']);
  });

  it('drops a trailing flag and an empty --root=', () => {
    expect(withoutRootArgs(['a', '--root'])).toEqual(['a']);
    expect(withoutRootArgs(['a', '-r'])).toEqual(['a']);
    expect(withoutRootArgs(['a', '--root='])).toEqual(['a']);
  });

  it('does not change its input', () => {
    const args = ['a', '--root', '/p'];
    withoutRootArgs(args);
    expect(args).toEqual(['a', '--root', '/p']);
  });
});

describe('withRootArg', () => {
  it('appends --root <root> after the args', () => {
    expect(MCP_ROOT_FLAG).toBe('--root');
    expect(withRootArg(['-y', 'factstack-mcp'], '/p')).toEqual([
      '-y',
      'factstack-mcp',
      '--root',
      '/p',
    ]);
    expect(withRootArg([], 'C:\\a b')).toEqual(['--root', 'C:\\a b']);
  });

  it('keeps earlier args as given, an empty --root= included', () => {
    expect(withRootArg(['s.js', '--root='], '/y')).toEqual(['s.js', '--root=', '--root', '/y']);
    expect(withRootArg(['s.js', '--root', '/x', '--root='], '/y')).toEqual([
      's.js',
      '--root',
      '/x',
      '--root=',
      '--root',
      '/y',
    ]);
    // `--root --root` is a flag and its value, not a dangling flag.
    expect(withRootArg(['--root', '--root'], '/y')).toEqual(['--root', '--root', '--root', '/y']);
  });

  it('drops a trailing flag with no value, which would otherwise take --root as its value', () => {
    expect(withRootArg(['s.js', '--root'], '/y')).toEqual(['s.js', '--root', '/y']);
    expect(withRootArg(['s.js', '-r'], '/y')).toEqual(['s.js', '--root', '/y']);
  });

  it('does not change its input', () => {
    const args = ['s.js', '--root'];
    withRootArg(args, '/y');
    expect(args).toEqual(['s.js', '--root']);
  });
});

describe('the three helpers agree (every arg list up to 4 long)', () => {
  const lists = argLists(4);

  it('the appended root is the one read back, and nothing else changes', () => {
    for (const args of lists) {
      const pinned = withRootArg(args, '/r');
      expect(rootArgOf(pinned), JSON.stringify(args)).toBe('/r');
      expect(withoutRootArgs(pinned), JSON.stringify(args)).toEqual(withoutRootArgs(args));
    }
  });

  it('withoutRootArgs leaves no root behind and is idempotent', () => {
    for (const args of lists) {
      const rest = withoutRootArgs(args);
      expect(rootArgOf(rest), JSON.stringify(args)).toBeUndefined();
      expect(withoutRootArgs(rest), JSON.stringify(args)).toEqual(rest);
    }
  });

  it('withRootArg is a plain append unless the args end in a flag with no value', () => {
    for (const args of lists) {
      const last = args[args.length - 1];
      const plain = withRootArg(args, '/r').slice(0, -2);
      if (plain.length === args.length) expect(plain, JSON.stringify(args)).toEqual(args);
      else {
        expect(last === '--root' || last === '-r', JSON.stringify(args)).toBe(true);
        expect(plain, JSON.stringify(args)).toEqual(args.slice(0, -1));
      }
    }
  });
});
