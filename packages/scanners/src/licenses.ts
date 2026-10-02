/**
 * @factstack/scanners — license detection + GPL-in-proprietary flagging.
 *
 * Two signals:
 *   1. **SPDX declaration** — source files often begin with a license
 *      header (`// SPDX-License-Identifier: MIT`). Recognize and count.
 *   2. **Manifest declaration** — package.json `license` / Python
 *      pyproject.toml `license` / cargo Cargo.toml `license`.
 *
 * Output shape:
 *   - `fileLicenses: Map<path, spdxExpression>` — per-file headers
 *   - `projectLicense: spdxExpression | null` — the root project's manifest
 *     (or a fingerprinted LICENSE file, see detectLicenseText)
 *   - `risks: LicenseRisk[]` — copyleft code whose header leaves no
 *     permissive choice, found while the project offers a permissive or a
 *     closed-source license (high), an unrecognised one (medium), or none.
 *
 * Both sides are read as SPDX expressions (`MIT OR Apache-2.0`, parens,
 * `WITH` exceptions), plus the common non-SPDX spellings (`Apache 2.0`,
 * `GPLv3`, `MIT/Apache-2.0`, `SEE LICENSE IN …`).
 *
 * Pure-JS; stays isomorphic.
 */

export interface LicenseScanResult {
  projectLicense: string | null;
  fileLicenses: Map<string, string>;
  risks: LicenseRisk[];
}

export interface LicenseRisk {
  severity: 'info' | 'low' | 'medium' | 'high';
  /** Human-readable one-liner. */
  message: string;
  /** File triggering the finding, if any. */
  file?: string;
  /** SPDX identifier that triggered the finding. */
  license?: string;
}

/** Common SPDX ids we recognize. Non-exhaustive but covers the 99%. */
const SPDX_IDS = [
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'CC0-1.0',
  'Unlicense',
  '0BSD',
  'BlueOak-1.0.0',
  'BSL-1.0',
  'Zlib',
  'Python-2.0',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.0',
  'LGPL-2.0-only',
  'LGPL-2.0-or-later',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'EUPL-1.2',
  'Proprietary',
  'UNLICENSED',
] as const;

const COPYLEFT = new Set([
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.0',
  'LGPL-2.0-only',
  'LGPL-2.0-or-later',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
]);

const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  'CC0-1.0',
  'Unlicense',
  '0BSD',
  'BlueOak-1.0.0',
  'BSL-1.0',
  'Zlib',
  'Python-2.0',
]);

const SPDX_BY_LOWER = new Map<string, string>(SPDX_IDS.map((s) => [s.toLowerCase(), s]));

/** Canonical spelling of one SPDX id: known ids in their SPDX case, and the
 *  deprecated `GPL-2.0+` form as `GPL-2.0-or-later`. Unknown ids unchanged. */
function canonicalId(raw: string): string {
  const plus = /^((?:A|L)?GPL-\d\.\d)\+$/i.exec(raw);
  const id = plus ? `${plus[1]}-or-later` : raw;
  return SPDX_BY_LOWER.get(id.toLowerCase()) ?? id;
}

type LicenseClass = 'permissive' | 'copyleft' | 'proprietary' | 'unknown';

/** Non-SPDX spellings seen in manifests, matched against the whole string. */
const ALIASES: Array<[RegExp, string]> = [
  [/^(?:the\s+)?mit(?:\s+license)?$/i, 'MIT'],
  [
    /^(?:the\s+)?apache(?:\s+software)?(?:\s+license)?[\s,-]*(?:v(?:ersion)?\.?\s*)?2(?:\.0)?$/i,
    'Apache-2.0',
  ],
  [/^(?:the\s+)?isc(?:\s+license)?$/i, 'ISC'],
  [/^(?:new\s+|revised\s+|modified\s+)?bsd(?:\s+license)?$/i, 'BSD-3-Clause'],
  [/^bsd[\s-]*3(?:[\s-]*clause)?(?:\s+license)?$/i, 'BSD-3-Clause'],
  [/^(?:simplified\s+|freebsd\s+)?bsd[\s-]*2(?:[\s-]*clause)?(?:\s+license)?$/i, 'BSD-2-Clause'],
  [/^(?:the\s+)?unlicense$/i, 'Unlicense'],
  [/^cc0(?:[\s-]*1\.0)?$/i, 'CC0-1.0'],
  [/^(?:mpl|mozilla\s+public\s+license)[\s,-]*(?:v(?:ersion)?\.?\s*)?2(?:\.0)?$/i, 'MPL-2.0'],
];
/** `GPLv3`, `GNU GPL v2+`, `LGPL-2.1 or later`, `AGPL-3` … */
const GPL_SPELLING =
  /^(?:gnu\s+)?(a|l)?gpl[\s-]*v?(\d)(?:\.(\d))?(\+|[\s-]*or[\s-]*later|[\s-]*only)?$/i;
const BARE_GPL = /^(?:gnu\s+)?(?:a|l)?gpl$/i;
const PROPRIETARY =
  /^(?:unlicensed|proprietary|commercial|private|closed(?:[\s-]*source)?|all\s+rights\s+reserved|licenseref-[\w.-]*(?:proprietary|commercial|closed)[\w.-]*)$|^see\s+licen[cs]e\s+in\b/i;

/** Canonical id for a single license name, SPDX or a known alias. */
function normalizeLicenseName(raw: string): string {
  const t = raw.trim();
  for (const [re, id] of ALIASES) if (re.test(t)) return id;
  const g = GPL_SPELLING.exec(t);
  if (g) {
    const suffix = !g[4] ? '' : /only/i.test(g[4]) ? '-only' : '-or-later';
    return canonicalId(`${(g[1] ?? '').toUpperCase()}GPL-${g[2]}.${g[3] ?? '0'}${suffix}`);
  }
  return canonicalId(t);
}

function classOf(name: string): LicenseClass {
  const id = normalizeLicenseName(name);
  if (COPYLEFT.has(id) || BARE_GPL.test(name.trim())) return 'copyleft';
  if (PERMISSIVE.has(id)) return 'permissive';
  if (PROPRIETARY.test(name.trim())) return 'proprietary';
  return 'unknown';
}

type LicenseExpr = { id: string } | { op: 'AND' | 'OR'; args: LicenseExpr[] };

/** Parse an SPDX expression (AND binds tighter than OR; parens; `WITH x`
 *  exceptions dropped; the legacy Cargo `/` read as OR). Null on anything
 *  that is not a well-formed expression. */
function parseExpression(raw: string): LicenseExpr | null {
  const tokens = raw
    .replace(/([()/])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === '/' ? 'OR' : /^(?:and|or|with)$/i.test(t) ? t.toUpperCase() : t));
  let pos = 0;
  const atom = (): LicenseExpr | null => {
    const t = tokens[pos++];
    if (t === '(') {
      const e = or();
      return tokens[pos++] === ')' ? e : null;
    }
    if (!t || t === ')' || t === 'AND' || t === 'OR' || t === 'WITH') return null;
    if (tokens[pos] === 'WITH') pos += 2; // an exception narrows, never widens, the terms
    return { id: t };
  };
  const chain = (op: 'AND' | 'OR', next: () => LicenseExpr | null) => (): LicenseExpr | null => {
    const args: LicenseExpr[] = [];
    do {
      const e = next();
      if (!e) return null;
      args.push(e);
    } while (tokens[pos] === op && ++pos);
    return args.length === 1 ? args[0]! : { op, args };
  };
  const and = chain('AND', atom);
  const or = chain('OR', and);
  const e = or();
  return e && pos === tokens.length ? e : null;
}

/** The class of each license a recipient may choose from under `expr` —
 *  one entry per OR alternative. Under AND every term binds at once, so the
 *  strictest wins: copyleft > proprietary > unknown > permissive. */
function offers(expr: LicenseExpr): LicenseClass[] {
  if ('id' in expr) return [classOf(expr.id)];
  if (expr.op === 'OR') return [...new Set(expr.args.flatMap(offers))];
  const rank: LicenseClass[] = ['permissive', 'unknown', 'proprietary', 'copyleft'];
  let acc: LicenseClass[] = ['permissive'];
  for (const arg of expr.args) {
    const next = new Set<LicenseClass>();
    for (const a of acc)
      for (const b of offers(arg)) next.add(rank.indexOf(a) >= rank.indexOf(b) ? a : b);
    acc = [...next];
  }
  return acc;
}

/** Offers of a license string: a whole-string alias first ('Apache 2.0',
 *  'SEE LICENSE IN x'), then an SPDX expression, else unknown. */
function licenseOffers(raw: string): LicenseClass[] {
  const whole = classOf(raw);
  if (whole !== 'unknown') return [whole];
  const expr = parseExpression(raw);
  return expr ? offers(expr) : ['unknown'];
}

/** Extract the SPDX expression from a file header (first 60 lines). */
export function scanFileLicense(source: string): string | null {
  const head = source.split('\n').slice(0, 60).join('\n');
  // The expression runs to the end of the line or a closing comment (`*/`,
  // `-->`): stop at the first character an expression can't hold.
  const m = /SPDX-License-Identifier:[ \t]*([A-Za-z0-9.+\-:() \t]+)/i.exec(head);
  const expr = m?.[1]?.replace(/[\s-]+$/, '');
  if (!expr) return null;
  // Trailing prose on the line (`MIT Copyright 2020 …`): keep the first id.
  if (!parseExpression(expr)) return canonicalId(expr.split(/[\s()]+/).find(Boolean) ?? expr);
  return expr
    .replace(/([()])/g, ' $1 ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (/^(?:and|or|with)$/i.test(t) || /[()]/.test(t) ? t.toUpperCase() : canonicalId(t)))
    .join(' ')
    .replace(/\(\s/g, '(')
    .replace(/\s\)/g, ')');
}

/** A root file that holds the project's license text. */
export function isLicenseFileName(name: string): boolean {
  return (
    /^(?:LICEN[CS]E|COPYING)(?:[-_.][A-Za-z0-9.-]+)?$/i.test(name) &&
    !/\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|php|cs|swift|sh|json|ya?ml|toml)$/i.test(name)
  );
}

/** Opening phrases of the common license texts, most specific first (the
 *  LGPL/AGPL texts mention the GPL; ISC and 0BSD share their grant). */
const LICENSE_TEXTS: Array<[RegExp, string]> = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE Version 3/i, 'AGPL-3.0'],
  [/GNU LESSER GENERAL PUBLIC LICENSE Version 3/i, 'LGPL-3.0'],
  [/GNU LESSER GENERAL PUBLIC LICENSE Version 2\.1/i, 'LGPL-2.1'],
  [/GNU LIBRARY GENERAL PUBLIC LICENSE Version 2/i, 'LGPL-2.0'],
  [/GNU GENERAL PUBLIC LICENSE Version 3/i, 'GPL-3.0'],
  [/GNU GENERAL PUBLIC LICENSE Version 2/i, 'GPL-2.0'],
  [/Apache License,? Version 2\.0/i, 'Apache-2.0'],
  [/Mozilla Public License,? (?:Version|v\.) 2\.0/i, 'MPL-2.0'],
  [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, 'MIT'],
  [/with or without fee is hereby granted, provided that/i, 'ISC'],
  [/with or without fee is hereby granted\./i, '0BSD'],
  [
    /Redistribution and use in source and binary forms.*(?:Neither the name|endorse or promote)/i,
    'BSD-3-Clause',
  ],
  [/Redistribution and use in source and binary forms/i, 'BSD-2-Clause'],
  [/This is free and unencumbered software released into the public domain/i, 'Unlicense'],
  [/Boost Software License - Version 1\.0/i, 'BSL-1.0'],
  [/CC0 1\.0 Universal/i, 'CC0-1.0'],
];

/** SPDX id of a LICENSE / COPYING file's text, or null when unrecognised. */
export function detectLicenseText(text: string): string | null {
  const spdx = scanFileLicense(text);
  if (spdx) return spdx;
  const flat = text.slice(0, 8000).replace(/\s+/g, ' ');
  for (const [re, id] of LICENSE_TEXTS) if (re.test(flat)) return id;
  return null;
}

/** Read `license` from package.json content. Returns normalized SPDX id. */
export function scanManifestLicense(text: string, filename: string): string | null {
  try {
    if (filename === 'package.json') {
      const j = JSON.parse(text);
      if (typeof j.license === 'string') return j.license;
      // Legacy object form: `"license": { "type": "MIT", "url": "…" }`.
      if (typeof j.license?.type === 'string') return j.license.type;
    }
    if (filename === 'pyproject.toml') {
      const m = /^\s*license\s*=\s*(?:\{\s*text\s*=\s*)?['"]([^'"]+)['"]/im.exec(text);
      if (m && m[1]) return m[1];
    }
    if (filename === 'Cargo.toml') {
      const m = /^\s*license\s*=\s*['"]([^'"]+)['"]/im.exec(text);
      if (m && m[1]) return m[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

export interface DeriveLicenseOptions {
  /** A root LICENSE / COPYING file exists (recognised or not): the project
   *  does declare a license, so "no license" is not reported. */
  hasLicenseFile?: boolean;
}

/**
 * Given per-file SPDX expressions and the root project license, flag copyleft
 * code that conflicts with what the project offers: a permissive license
 * (legal risk for shipping a non-GPL product that silently absorbed GPL code)
 * or a closed-source one (the product's source can be forced open) — high;
 * an unrecognised license — medium. A copyleft project is not flagged.
 * A file header only counts when every license it offers is copyleft
 * (`GPL-2.0-only OR MIT` can be taken as MIT).
 */
export function deriveLicenseRisks(
  projectLicense: string | null,
  fileLicenses: Map<string, string>,
  opts: DeriveLicenseOptions = {},
): LicenseRisk[] {
  const risks: LicenseRisk[] = [];
  const project = projectLicense ? licenseOffers(projectLicense) : null;

  for (const [file, id] of fileLicenses) {
    const fileOffers = licenseOffers(id);
    if (!fileOffers.every((c) => c === 'copyleft')) continue;
    if (!project) {
      risks.push({
        severity: 'medium',
        message: opts.hasLicenseFile
          ? `${id} header found; the project's LICENSE file was not recognised, so compatibility is unknown.`
          : `${id} header found; no project license declared.`,
        file,
        license: id,
      });
    } else if (project.includes('permissive')) {
      risks.push({
        severity: 'high',
        message: `${id} header in a ${projectLicense} project — copyleft may bind the whole distribution.`,
        file,
        license: id,
      });
    } else if (project.includes('proprietary')) {
      risks.push({
        severity: 'high',
        message: `${id} header in a closed-source (${projectLicense}) project — shipping it can force the product's source open.`,
        file,
        license: id,
      });
    } else if (!project.every((c) => c === 'copyleft')) {
      risks.push({
        severity: 'medium',
        message: `${id} header found; compatibility with the project license "${projectLicense}" is unknown.`,
        file,
        license: id,
      });
    }
  }

  if (!projectLicense && !opts.hasLicenseFile) {
    risks.push({
      severity: 'low',
      message:
        'No project license declared. Add a "license" field to package.json (or a LICENSE file).',
    });
  }

  return risks;
}
