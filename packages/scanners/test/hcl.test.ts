/**
 * Tests for the F11 Terraform/HCL parser: resource blocks, implicit
 * interpolation dependencies, explicit `depends_on`, comment stripping,
 * and non-resource refs (var/local) being ignored.
 */

import { describe, expect, it } from 'vitest';
import { parseHcl } from '../src/hcl.js';

const TF = `# network stack
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = var.subnet_cidr
}

resource "aws_instance" "web" {
  subnet_id  = aws_subnet.app.id
  depends_on = [aws_vpc.main]
  # ami = aws_vpc.ghost.id
  tags = { Name = "web" }
}
`;

describe('parseHcl', () => {
  const { resources, dependencies } = parseHcl(TF);

  it('finds all resource blocks', () => {
    expect(resources.map((r) => `${r.type}.${r.name}`).sort()).toEqual([
      'aws_instance.web',
      'aws_subnet.app',
      'aws_vpc.main',
    ]);
  });

  it('captures implicit interpolation dependencies', () => {
    const appDeps = dependencies.filter((d) => d.fromName === 'app');
    expect(appDeps).toHaveLength(1);
    expect(appDeps[0]).toMatchObject({ toType: 'aws_vpc', toName: 'main' });
  });

  it('captures explicit depends_on + interpolation together (deduped)', () => {
    const webTargets = dependencies
      .filter((d) => d.fromName === 'web')
      .map((d) => `${d.toType}.${d.toName}`)
      .sort();
    expect(webTargets).toEqual(['aws_subnet.app', 'aws_vpc.main']);
  });

  it('ignores non-resource references (var/local) and commented refs', () => {
    // `var.subnet_cidr` is not a declared resource → no edge.
    // `# ami = aws_vpc.ghost.id` is commented → no edge; ghost is undeclared anyway.
    const targets = dependencies.map((d) => `${d.toType}.${d.toName}`);
    expect(targets).not.toContain('aws_vpc.ghost');
    expect(targets.every((t) => t.startsWith('aws_'))).toBe(true);
  });

  it('survives brace-containing string interpolations', () => {
    // The `tags = { Name = "web" }` block must not unbalance brace matching.
    expect(resources.find((r) => r.name === 'web')).toBeDefined();
  });

  it('reports accurate 1-indexed line numbers', () => {
    expect(resources.find((r) => r.name === 'main')!.line).toBe(2);
  });

  it('returns empty for non-HCL input', () => {
    const r = parseHcl('just some prose with a.b dotted tokens');
    expect(r.resources).toEqual([]);
    expect(r.dependencies).toEqual([]);
  });

  it('is deterministic', () => {
    expect(parseHcl(TF)).toEqual(parseHcl(TF));
  });
});

describe('parseHcl — string & heredoc robustness (adversarial-verify regressions)', () => {
  it('does not lose a resource when a string contains */ (ARN/URL)', () => {
    const tf = `resource "aws_s3_bucket" "b" { policy = "arn:/*" }
/* a real comment */
resource "aws_instance" "web" { bucket = aws_s3_bucket.b.id }`;
    const r = parseHcl(tf);
    expect(r.resources.map((x) => `${x.type}.${x.name}`).sort()).toEqual([
      'aws_instance.web',
      'aws_s3_bucket.b',
    ]);
    expect(r.dependencies).toContainEqual(
      expect.objectContaining({ fromName: 'web', toName: 'b' }),
    );
  });

  it('does not miscount braces inside a heredoc body', () => {
    const tf = `resource "local_file" "config" {
  content = <<-EOF
{ "json": true }
EOF
}
resource "aws_s3_bucket" "data" { name = local_file.config.filename }`;
    const r = parseHcl(tf);
    expect(r.resources.map((x) => `${x.type}.${x.name}`).sort()).toEqual([
      'aws_s3_bucket.data',
      'local_file.config',
    ]);
    expect(r.dependencies).toContainEqual(
      expect.objectContaining({ fromName: 'data', toName: 'config' }),
    );
  });

  // SCN-10 — the string ended at the first NESTED quote, so `/*` in the
  // interpolation's inner string opened a comment that ate the rest of the file.
  it('keeps resources after a legacy interpolation with a nested quoted "/*"', () => {
    const tf = `resource "aws_s3_bucket" "b" {
  bucket = "data"
}
resource "aws_iam_policy" "p" {
  policy = "\${format("arn:aws:s3:::%s/*", aws_s3_bucket.b.id)}"
}
resource "aws_iam_role" "r" {
  name = "role-{\${aws_iam_policy.p.name}}"
}
resource "aws_lambda_function" "fn" {
  role = aws_iam_role.r.arn
  note = "literal $\${not.interp} and \\"escaped\\""
}`;
    const r = parseHcl(tf);
    expect(r.resources.map((x) => `${x.type}.${x.name}`)).toEqual([
      'aws_s3_bucket.b',
      'aws_iam_policy.p',
      'aws_iam_role.r',
      'aws_lambda_function.fn',
    ]);
    expect(r.dependencies.map((d) => `${d.fromName}->${d.toName}@${d.line}`)).toEqual([
      'p->b@5',
      'r->p@8',
      'fn->r@11',
    ]);
  });
});

/* SCN-REV-1 — the string/template scan recursed once per nested `"${`, so a
   few thousand levels overflowed the stack and aborted the whole analyze. */
describe('parseHcl — deeply nested templates', () => {
  it('does not throw on 10k unterminated nested "${', () => {
    const tf = 'resource "a" "b" {\n  x = ' + '"${'.repeat(10_000);
    expect(() => parseHcl(tf)).not.toThrow();
  });

  it('keeps the resources around a 10k-deep balanced nest', () => {
    const d = 10_000;
    const nest = '"${f('.repeat(d) + 'x' + ')}"'.repeat(d);
    const tf = `resource "a" "b" {\n  x = ${nest}\n}\nresource "c" "d" {\n  y = a.b.id\n}`;
    const r = parseHcl(tf);
    expect(r.resources.map((x) => `${x.type}.${x.name}@${x.line}`)).toEqual(['a.b@1', 'c.d@4']);
    expect(r.dependencies.map((x) => `${x.fromName}->${x.toName}@${x.line}`)).toEqual(['d->b@5']);
  });
});

/* SCN-09 — each resource's and reference's line re-counted from offset 0. */
describe('parseHcl — near-linear on large files', () => {
  it('parses ~1 MB of generated Terraform quickly, lines intact', () => {
    const parts: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const prev =
        i > 0 ? `  subnet_id = aws_subnet.s${i - 1}.id\n  vpc_id    = aws_vpc.v${i - 1}.id\n` : '';
      parts.push(
        `resource "aws_subnet" "s${i}" {\n${prev}  cidr_block = "10.0.0.0/24"\n  tags = { Name = "subnet-${i}" }\n}\nresource "aws_vpc" "v${i}" {\n  cidr_block = "10.${i % 250}.0.0/16"\n}`,
      );
    }
    const tf = parts.join('\n');
    expect(tf.length).toBeGreaterThan(900_000);
    const t0 = performance.now();
    const r = parseHcl(tf);
    const ms = performance.now() - t0;
    expect(r.resources).toHaveLength(12000);
    expect(r.dependencies).toHaveLength(2 * 5999);
    const last = r.resources[11998]!; // aws_subnet.s5999
    expect(last.line).toBe(tf.split('\n').indexOf('resource "aws_subnet" "s5999" {') + 1);
    expect(ms).toBeLessThan(3000);
  });
});
