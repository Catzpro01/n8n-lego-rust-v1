#!/usr/bin/env python3
"""P5-M08 — derive `data/public-api-openapi.json` from the pinned upstream spec.

Reads reference/n8n/packages/cli/src/public-api/v1/openapi.yml (n8n 2.9.4),
inlines every relative `$ref`, and keeps ONLY the operations this product
mounts (PUBLIC_API_OPERATIONS in src/auth/public-api-routes.mjs, read through
node so there is a single source of truth). The server serves the result as
`GET /api/v1/openapi.yml`; test/public-api-v1.test.mjs asserts the file and
the mounted table stay identical, so an unmounted operation is never
advertised.

Dev-time only (needs PyYAML); the runtime reads the committed JSON.
Usage: python3 apps/n8n-lego/scripts/extract-public-api-spec.py
"""
import json
import os
import re
import subprocess
import sys

import yaml

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(APP))
SPEC_DIR = os.path.join(REPO, 'reference', 'n8n', 'packages', 'cli', 'src', 'public-api', 'v1')
OUT = os.path.join(APP, 'data', 'public-api-openapi.json')


def load(path):
    with open(path, encoding='utf-8') as handle:
        return yaml.safe_load(handle)


SCHEMAS = {}
SCHEMA_NAMES = {}


def schema_ref(target, stack):
    """Shared schema files become `#/components/schemas/<Name>` once."""
    if target not in SCHEMA_NAMES:
        stem = os.path.splitext(os.path.basename(target))[0]
        name = ''.join(part[:1].upper() + part[1:] for part in re.split(r'[.\-_]', stem))
        while name in SCHEMAS:
            name += '_'
        SCHEMA_NAMES[target] = name
        SCHEMAS[name] = None
        SCHEMAS[name] = inline(load(target), os.path.dirname(target), stack + (target,))
    return {'$ref': f'#/components/schemas/{SCHEMA_NAMES[target]}'}


def inline(node, base, stack=()):
    if isinstance(node, dict):
        ref = node.get('$ref')
        if isinstance(ref, str) and not ref.startswith('#'):
            target = os.path.normpath(os.path.join(base, ref))
            parts = target.split(os.sep)
            if 'schemas' in parts and 'parameters' not in parts and len(node) == 1:
                return schema_ref(target, stack)
            if target in stack:
                raise SystemExit(f'circular $ref: {target}')
            resolved = inline(load(target), os.path.dirname(target), stack + (target,))
            siblings = {k: inline(v, base, stack) for k, v in node.items() if k != '$ref'}
            return {**resolved, **siblings} if isinstance(resolved, dict) else resolved
        return {k: inline(v, base, stack) for k, v in node.items()}
    if isinstance(node, list):
        return [inline(item, base, stack) for item in node]
    return node


def mounted():
    script = (
        "Promise.all([import('./src/auth/public-api-routes.mjs'), import('./src/auth/public-api-backing.mjs')]).then(([routes, backing]) => "
        "console.log(JSON.stringify(routes.PUBLIC_API_OPERATIONS.concat(backing.BACKING_RESOURCE_ROUTES).map((o) => [o.method, o.path]))))"
    )
    out = subprocess.run(['node', '-e', script], cwd=APP, check=True, capture_output=True, text=True).stdout
    return [(method.lower(), re.sub(r':([A-Za-z]+)', r'{\1}', path)) for method, path in json.loads(out)]


def main():
    root = load(os.path.join(SPEC_DIR, 'openapi.yml'))
    wanted = mounted()
    paths = {}
    for method, path in wanted:
        entry = root['paths'].get(path)
        if entry is None:
            raise SystemExit(f'mounted path not in upstream spec: {path}')
        item = inline(entry, SPEC_DIR)
        if method not in item:
            raise SystemExit(f'mounted operation not in upstream spec: {method.upper()} {path}')
        op = {k: v for k, v in item[method].items() if not k.startswith('x-eov-')}
        paths.setdefault(path, {})[method] = op
    used_tags = {tag for item in paths.values() for op in item.values() for tag in op.get('tags', [])}
    spec = {
        'openapi': root['openapi'],
        'info': root['info'],
        'externalDocs': root['externalDocs'],
        'servers': root['servers'],
        'tags': [tag for tag in root['tags'] if tag['name'] in used_tags],
        'paths': paths,
        'components': {'schemas': dict(sorted(SCHEMAS.items())), 'securitySchemes': root['components']['securitySchemes']},
        'security': root['security'],
        'x-n8n-lego': {
            'source': 'reference/n8n/packages/cli/src/public-api/v1/openapi.yml (n8n 2.9.4)',
            'note': 'Only the operations this build mounts; shared schemas under components.schemas, other relative $refs inlined.',
            'operations': len(wanted),
        },
    }
    with open(OUT, 'w', encoding='utf-8') as handle:
        json.dump(spec, handle, indent=2, sort_keys=False)
        handle.write('\n')
    print(f'wrote {os.path.relpath(OUT, REPO)}: {len(wanted)} operations, {len(paths)} paths')


if __name__ == '__main__':
    sys.exit(main())
