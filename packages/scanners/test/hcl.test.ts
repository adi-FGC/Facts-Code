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
    expect(r.dependencies).toContainEqual(expect.objectContaining({ fromName: 'web', toName: 'b' }));
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
});
