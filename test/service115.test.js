import test from 'node:test'
import assert from 'node:assert/strict'

import { Service115 } from '../src/service115.js'

test('getShareInfo merges paginated snap results', async () => {
  const calls = []
  const http = {
    async get(url, options) {
      calls.push(options.params.offset)
      const offset = options.params.offset
      return {
        data: {
          state: true,
          data: {
            count: 3,
            share_title: 'demo',
            list: offset === 0
              ? [{ fid: '1', n: 'a.mkv' }, { fid: '2', n: 'b.mkv' }]
              : [{ fid: '3', n: 'c.mkv' }],
          },
        },
      }
    },
  }
  const service = new Service115({ http, pageSize: 2 })
  const info = await service.getShareInfo('cookie', 'share', 'pwd')
  assert.deepEqual(calls, [0, 2])
  assert.deepEqual(info.fileIds, ['1', '2', '3'])
  assert.equal(info.count, 3)
})
