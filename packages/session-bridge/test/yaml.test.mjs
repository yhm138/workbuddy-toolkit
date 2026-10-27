import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, plainify } from '../src/core/yaml.mjs';

const SAMPLE = `# patch layer
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access
- id: dsh-as-mcp
  config:
    http:
      enabled: true
      port: 8790
      path: /mcp
- insert:
    - id: mcp-client-dsh-local
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: streamable-http
        url: http://127.0.0.1:8790/mcp
        headers:
          Authorization: !!js "'Bearer ' +
            token()"
        reconnect:
          enabled: true
          maxAttempts: 1000
- id: plugin-market
  config:
    indexes:
      - https://a.example/index.json
      - https://b.example/index.json
`;

test('parses nested mappings, sequences and inline tags', () => {
  const doc = plainify(parseYaml(SAMPLE));
  assert.equal(doc.length, 5);

  const locale = doc.find((entry) => entry.id === 'locale');
  assert.equal(locale.config.preference, 'zh');

  const permission = doc.find((entry) => entry.id === 'permission');
  assert.equal(permission.config.defaultPreset, 'danger-full-access');
  assert.equal(permission.config.presets['danger-full-access'].approval, 'never');

  const mcp = doc.find((entry) => entry.id === 'dsh-as-mcp');
  assert.equal(mcp.config.http.port, 8790);

  const insert = doc.find((entry) => entry.insert);
  assert.equal(insert.insert.length, 1);
  assert.equal(insert.insert[0].config.url, 'http://127.0.0.1:8790/mcp');
  assert.equal(insert.insert[0].config.reconnect.maxAttempts, 1000);
  assert.match(insert.insert[0].config.headers.Authorization, /Bearer/);

  const market = doc.find((entry) => entry.id === 'plugin-market');
  assert.deepEqual(market.config.indexes, ['https://a.example/index.json', 'https://b.example/index.json']);
});

test('keeps empty documents null and ignores comments', () => {
  assert.equal(parseYaml('# only a comment\n'), null);
  assert.deepEqual(plainify(parseYaml('[]')), []);
});

test('parses quoted scalars, booleans and numbers', () => {
  const doc = plainify(parseYaml('a: "x: y"\nb: true\nc: 20\nd: null\n'));
  assert.equal(doc.a, 'x: y');
  assert.equal(doc.b, true);
  assert.equal(doc.c, 20);
  assert.equal(doc.d, null);
});
