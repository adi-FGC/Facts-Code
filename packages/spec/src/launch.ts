/**
 * The npm names FACTS is launched by. The owner reserves and publishes these
 * (decision 2026-09-24: keep the npx launch path). Every installer, login
 * hint, discovery manifest and doc derives its command from here — three
 * spellings had drifted apart (`factstack-mcp`, `@factstack/mcp-server`,
 * `@factstack/cli`), and only one of them can ever be the published name.
 */

/** Published name of the CLI package (bin `factstack`). */
export const CLI_NPM_PACKAGE = 'factstack' as const;

/** Published name of the MCP server package (bin `factstack-mcp`). */
export const MCP_NPM_PACKAGE = 'factstack-mcp' as const;

/** How hooks invoke the CLI: `npx factstack`. */
export const CLI_NPX = `npx ${CLI_NPM_PACKAGE}` as const;

/** How MCP clients launch the server: `npx -y factstack-mcp`. */
export const MCP_NPX = `npx -y ${MCP_NPM_PACKAGE}` as const;

/**
 * Whether each name is on npm yet. Only the owner flips these, on publish.
 * Until then every surface that shows an npx command (registry manifests,
 * sign-in hints, installers) says "not published yet" instead of offering a
 * command that 404s. One flag per package, here, so no two surfaces disagree.
 * Typed `boolean` (not the literal) so callers' branches stay type-checked.
 */
export const CLI_PUBLISHED: boolean = false;
export const MCP_PUBLISHED: boolean = false;

/*
 * The MCP server's `--root` argv grammar, in one place: the server's own
 * parseServerArgs reads it, `factstack install` pins a project with it, and
 * the installers test whether a launch command already names a root. Three
 * hand-kept copies of this loop had to agree (mcp-1).
 *
 *   `--root <dir>` / `-r <dir>`: the flag takes the next arg as its value,
 *     even one spelled like a flag or sub-command (`--root login`).
 *   `--root=<dir>`: the value is inline.
 *   The LAST root wins. An empty value, or a trailing flag with no value,
 *   names no root.
 */

/** The flag installers write: `--root <dir>`. */
export const MCP_ROOT_FLAG = '--root' as const;

const ROOT_INLINE = `${MCP_ROOT_FLAG}=`;

function isRootFlag(a: string): boolean {
  return a === MCP_ROOT_FLAG || a === '-r';
}

interface RootScan {
  /** The last value read ('' included — rootArgOf maps it to undefined). */
  root: string | undefined;
  /** Every arg that is neither a root flag nor a root value, in order. */
  rest: string[];
  /** The args end in `--root` / `-r` with no value after it. */
  dangling: boolean;
}

function scanRootArgs(args: readonly string[]): RootScan {
  let root: string | undefined;
  let dangling = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (isRootFlag(a)) {
      if (i + 1 < args.length) root = args[++i];
      else dangling = true;
    } else if (a.startsWith(ROOT_INLINE)) root = a.slice(ROOT_INLINE.length);
    else rest.push(a);
  }
  return { root, rest, dangling };
}

/** The project root these args name, as the MCP server reads it, or
 *  undefined when they name none. */
export function rootArgOf(args: readonly string[]): string | undefined {
  return scanRootArgs(args).root || undefined;
}

/** The args with every root spelling removed (a flag, its value, and a
 *  trailing flag with no value). Everything else keeps its order. */
export function withoutRootArgs(args: readonly string[]): string[] {
  return scanRootArgs(args).rest;
}

/**
 * The args plus `--root <root>` at the end, so the server reads `root`
 * (the last root wins). Earlier args are kept as given, an empty `--root=`
 * included. The one exception is a trailing `--root` / `-r` with no value:
 * it names nothing, and left in place it would take the appended flag as its
 * value, so it is dropped.
 */
export function withRootArg(args: readonly string[], root: string): string[] {
  const kept = scanRootArgs(args).dangling ? args.slice(0, -1) : [...args];
  return [...kept, MCP_ROOT_FLAG, root];
}
