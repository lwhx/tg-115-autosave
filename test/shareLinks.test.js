import test from 'node:test'
import assert from 'node:assert/strict'

import { parse115ShareLinks, sanitizeFileName } from '../src/shareLinks.js'

test('parses 115cdn password URL', () => {
  const links = parse115ShareLinks('https://115cdn.com/s/swf0k0j3w30?password=h6e7#')
  assert.deepEqual(links[0], {
    shareCode: 'swf0k0j3w30',
    receiveCode: 'h6e7',
    raw: 'https://115cdn.com/s/swf0k0j3w30?password=h6e7',
  })
})

test('parses nearby Chinese receive code', () => {
  const links = parse115ShareLinks('链接：https://115cdn.com/s/abc123# 提取码：zz99')
  assert.equal(links[0].shareCode, 'abc123')
  assert.equal(links[0].receiveCode, 'zz99')
})

test('sanitizes illegal folder characters', () => {
  assert.equal(sanitizeFileName('a<b>c: d*'), 'a b c d')
})
