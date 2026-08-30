import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactToolManifest } from '../tools/manifest.ts';

test('buildCompactToolManifest: generates compact TypeScript-like signatures', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The file path' },
            start_line: { type: 'number' },
            end_line: { type: 'number' },
            encoding: { type: 'string', enum: ['utf-8', 'ascii'] },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['path'],
        },
      },
    },
  ];

  const manifest = buildCompactToolManifest(tools);
  console.log('Generated Manifest:\n', manifest);

  assert.ok(manifest.includes('read_file('));
  assert.ok(manifest.includes('path: string'));
  assert.ok(manifest.includes('start_line?: number'));
  assert.ok(manifest.includes('end_line?: number'));
  assert.ok(manifest.includes('encoding?: "utf-8" | "ascii"'));
  assert.ok(manifest.includes('tags?: string[]'));
  assert.ok(manifest.includes('- Read the contents of a file.'));
});
