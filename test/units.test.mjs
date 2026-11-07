import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontmatter, serializeFrontmatter } from '../src/frontmatter.mjs'
import { newId, shardOf, contentHash } from '../src/ids.mjs'
import { indexTokens, queryExpression, segments } from '../src/text.mjs'

test('块头：空串、数组、嵌套都能原样往返', () => {
  const meta = {
    id: 'k261031abcdef',
    type: 'experience',
    title: '标题: 带冒号',
    summary: '',
    source: '',
    area: 'default',
    created_at: '2026-10-31T00:00:00.000Z',
    modified_at: '2026-10-31T00:00:00.000Z',
    version: 2,
    editor: 'local',
    status: 'unverified',
    content_hash: 'abc',
    links: ['k261031aaaaaa', 'k261031bbbbbb'],
    experience: { trigger: 'failure', used: 3, succeeded: 2, evidence: ['k261031cccccc'] },
  }
  const text = serializeFrontmatter(meta, '正文第一行\n\n正文第二行')
  const back = parseFrontmatter(text)
  assert.equal(back.meta.summary, '')
  assert.equal(back.meta.source, '')
  assert.equal(back.meta.title, '标题: 带冒号')
  assert.deepEqual(back.meta.links, ['k261031aaaaaa', 'k261031bbbbbb'])
  assert.equal(back.meta.experience.used, 3)
  assert.equal(back.meta.experience.succeeded, 2)
  assert.deepEqual(back.meta.experience.evidence, ['k261031cccccc'])
  assert.equal(back.body.trim(), '正文第一行\n\n正文第二行')
})

test('id：格式稳定、同参数可复现、盐不同则不同', () => {
  const at = new Date('2026-10-31T12:00:00Z')
  const a = newId({ at, title: '同一个标题', salt: 'x' })
  const b = newId({ at, title: '同一个标题', salt: 'x' })
  const c = newId({ at, title: '同一个标题', salt: 'y' })
  assert.match(a, /^k261031[0-9a-z]{6}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(shardOf(a), a.slice(-6, -4))
  assert.equal(contentHash('abc'), contentHash('abc'))
  assert.notEqual(contentHash('abc'), contentHash('abd'))
})

test('分词：汉字切二元组、拉丁整词、单字直通', () => {
  const tokens = indexTokens('本地知识库 FTS5 好用').split(' ')
  assert.deepEqual(tokens, ['本地', '地知', '知识', '识库', 'fts5', '好用'])
  assert.equal(queryExpression('知识'), '"知识"')
  assert.equal(queryExpression('知识库'), '"知识 识库"')
  assert.equal(queryExpression('知'), null)
  assert.equal(queryExpression('FTS5'), '"fts5"')
  assert.deepEqual(segments('知识库 FTS5').map((s) => s.kind), ['cjk', 'word'])
})
