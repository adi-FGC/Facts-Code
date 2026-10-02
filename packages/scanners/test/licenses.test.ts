import { describe, expect, it } from 'vitest';
import {
  deriveLicenseRisks,
  detectLicenseText,
  isLicenseFileName,
  scanFileLicense,
  scanManifestLicense,
} from '../src/licenses.js';

describe('scanFileLicense', () => {
  it('reads SPDX headers', () => {
    expect(scanFileLicense('// SPDX-License-Identifier: MIT\nexport const x = 1;')).toBe('MIT');
    expect(scanFileLicense('# SPDX-License-Identifier: Apache-2.0\nfoo = 1')).toBe('Apache-2.0');
  });
  it('returns null when absent', () => {
    expect(scanFileLicense('export const x = 1;')).toBeNull();
  });
});

describe('scanManifestLicense', () => {
  it('reads string license from package.json', () => {
    expect(scanManifestLicense('{"license":"MIT"}', 'package.json')).toBe('MIT');
  });
  it('reads legacy object form', () => {
    expect(scanManifestLicense('{"license":{"type":"ISC"}}', 'package.json')).toBe('ISC');
  });
  it('reads pyproject.toml', () => {
    expect(scanManifestLicense('license = "Apache-2.0"', 'pyproject.toml')).toBe('Apache-2.0');
  });
});

describe('deriveLicenseRisks', () => {
  it('flags GPL in an MIT project', () => {
    const fileLic = new Map([['src/bad.ts', 'GPL-3.0-only']]);
    const risks = deriveLicenseRisks('MIT', fileLic);
    expect(risks[0]?.severity).toBe('high');
    expect(risks[0]?.file).toBe('src/bad.ts');
  });
  it('flags missing license', () => {
    const risks = deriveLicenseRisks(null, new Map());
    expect(risks.some((r) => r.message.includes('No project license'))).toBe(true);
  });
});

/* 2026-09-24 regressions (correctness#7): the copyleft check only fired for an
   exact-match permissive id, so the highest-stakes case — GPL code in a closed
   product — and every compound / non-SPDX spelling produced nothing. */
describe('deriveLicenseRisks — closed, compound and non-SPDX project licenses', () => {
  const agpl = new Map([['src/vendored.ts', 'AGPL-3.0-only']]);
  const severities = (project: string) =>
    deriveLicenseRisks(project, agpl).map((r) => [r.severity, r.file]);

  it.each(['UNLICENSED', 'Proprietary', 'SEE LICENSE IN LICENSE.txt', 'LicenseRef-Commercial'])(
    'flags copyleft code in a closed-source project (%s) as high',
    (project) => {
      expect(severities(project)).toEqual([['high', 'src/vendored.ts']]);
      expect(deriveLicenseRisks(project, agpl)[0]!.message).toMatch(/closed-source/);
    },
  );

  it.each([
    'MIT OR Apache-2.0',
    '(MIT OR Apache-2.0)',
    'MIT/Apache-2.0',
    'Apache 2.0',
    'Apache License, Version 2.0',
    'MIT License',
    'BSD',
    'bsd-3-clause',
    'Apache-2.0 WITH LLVM-exception',
  ])('reads %s as permissive — a copyleft header is high', (project) => {
    expect(severities(project)).toEqual([['high', 'src/vendored.ts']]);
  });

  it('flags a dual copyleft-OR-commercial project: the commercial option is closed', () => {
    expect(severities('AGPL-3.0-only OR LicenseRef-Commercial')).toEqual([
      ['high', 'src/vendored.ts'],
    ]);
  });

  it.each(['GPL-3.0-only', 'AGPL-3.0-or-later', 'GPL-2.0+', 'GPLv3', 'MIT AND GPL-3.0-only'])(
    'leaves a copyleft project (%s) unflagged',
    (project) => {
      expect(severities(project)).toEqual([]);
    },
  );

  it('reports an unrecognised project license as medium, not silence', () => {
    const risks = deriveLicenseRisks('BUSL-1.1', agpl);
    expect(risks.map((r) => r.severity)).toEqual(['medium']);
    expect(risks[0]!.message).toContain('BUSL-1.1');
  });
});

/* SCN-03 — the header regex kept only the first token of an expression and the
   copyleft set lacked the `+` and LGPL-2.0 ids. */
describe('scanFileLicense — SPDX expressions and deprecated ids', () => {
  const inMit = (header: string) => {
    const id = scanFileLicense(header + '\nint main(void) { return 0; }');
    return { id, risks: id ? deriveLicenseRisks('MIT', new Map([['f', id]])) : [] };
  };

  it('maps the deprecated "+" suffix to or-later and flags it', () => {
    const r = inMit('/* SPDX-License-Identifier: GPL-2.0+ */');
    expect(r.id).toBe('GPL-2.0-or-later');
    expect(r.risks.map((x) => x.severity)).toEqual(['high']);
  });

  it('knows the LGPL-2.0 family', () => {
    for (const id of ['LGPL-2.0-only', 'LGPL-2.0-or-later', 'LGPL-2.0', 'LGPL-2.1+']) {
      expect(inMit(`// SPDX-License-Identifier: ${id}`).risks, id).toHaveLength(1);
    }
  });

  it('reads the whole expression: an OR with a permissive choice is not a conflict', () => {
    const plain = inMit('// SPDX-License-Identifier: GPL-2.0-only OR MIT');
    expect(plain.id).toBe('GPL-2.0-only OR MIT');
    expect(plain.risks).toEqual([]);
    const paren = inMit('/* SPDX-License-Identifier: (GPL-2.0-only OR MIT) */');
    expect(paren.id).toBe('(GPL-2.0-only OR MIT)');
    expect(paren.risks).toEqual([]);
  });

  it('flags an AND with a copyleft term, and a WITH exception on a GPL id', () => {
    expect(inMit('// SPDX-License-Identifier: GPL-2.0-only AND MIT').risks).toHaveLength(1);
    expect(inMit('// SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note').risks).toHaveLength(
      1,
    );
  });

  it('stops at a closing comment delimiter', () => {
    expect(scanFileLicense('<!-- SPDX-License-Identifier: MIT -->')).toBe('MIT');
    expect(scanFileLicense('/* SPDX-License-Identifier: Apache-2.0 */')).toBe('Apache-2.0');
  });

  it('keeps the first id when prose follows it on the line', () => {
    expect(scanFileLicense('// SPDX-License-Identifier: GPL-2.0 Copyright 2020 Foo')).toBe(
      'GPL-2.0',
    );
  });
});

/* SCN-04 — nothing read LICENSE / COPYING, so a repo with one still got "No
   software license is declared". */
describe('LICENSE file detection', () => {
  it('recognises license file names, and not source files named after licenses', () => {
    for (const n of [
      'LICENSE',
      'LICENSE.md',
      'LICENCE.txt',
      'COPYING',
      'COPYING.LESSER',
      'LICENSE-MIT',
      'license',
    ])
      expect(isLicenseFileName(n), n).toBe(true);
    for (const n of ['license.ts', 'licenses.ts', 'README.md', 'LICENSES', 'license-check.js'])
      expect(isLicenseFileName(n), n).toBe(false);
  });

  it('fingerprints the common license texts', () => {
    const cases: Array<[string, string]> = [
      [
        'MIT License\n\nCopyright (c) 2026 A\n\nPermission is hereby granted, free of charge, to any person obtaining a copy',
        'MIT',
      ],
      [
        '                                 Apache License\n                           Version 2.0, January 2004',
        'Apache-2.0',
      ],
      ['GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007', 'GPL-3.0'],
      ['GNU GENERAL PUBLIC LICENSE\n                       Version 2, June 1991', 'GPL-2.0'],
      [
        'GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007',
        'AGPL-3.0',
      ],
      [
        'GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007',
        'LGPL-3.0',
      ],
      [
        'GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 2.1, February 1999',
        'LGPL-2.1',
      ],
      ['Mozilla Public License Version 2.0\n==================================', 'MPL-2.0'],
      [
        'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products',
        'BSD-3-Clause',
      ],
      [
        'Redistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n1. Redistributions of source code must retain',
        'BSD-2-Clause',
      ],
      [
        'Permission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above',
        'ISC',
      ],
      ['This is free and unencumbered software released into the public domain.', 'Unlicense'],
    ];
    for (const [text, id] of cases) expect(detectLicenseText(text), id).toBe(id);
    expect(detectLicenseText('All rights reserved. Internal use only.')).toBeNull();
  });

  it('does not report a missing license when a LICENSE file exists', () => {
    expect(deriveLicenseRisks(null, new Map(), { hasLicenseFile: true })).toEqual([]);
    const gpl = deriveLicenseRisks(null, new Map([['a.c', 'GPL-2.0-only']]), {
      hasLicenseFile: true,
    });
    expect(gpl.map((r) => r.severity)).toEqual(['medium']);
    expect(gpl[0]!.message).toMatch(/LICENSE file/);
  });

  it('a fingerprinted GPL LICENSE makes the project copyleft (no conflict)', () => {
    const project = detectLicenseText('GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007');
    expect(deriveLicenseRisks(project, new Map([['a.c', 'GPL-3.0-or-later']]))).toEqual([]);
  });
});
