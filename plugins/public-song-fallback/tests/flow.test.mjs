import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entry = (
  await readFile(new URL('../../../dist/public-song-fallback/entry.mjs', import.meta.url), 'utf8')
).replace(
  /import \{ awaitOperation \} from "echo:plugin-sdk";/g,
  'const awaitOperation = operation => operation;',
);
const { activate } = await import(
  `data:text/javascript;base64,${Buffer.from(entry).toString('base64')}`
);
const signal = () => {
  const callbacks = new Set();
  return {
    connect: (cb) => callbacks.add(cb),
    disconnect: (cb) => callbacks.delete(cb),
    emit: (...args) => callbacks.forEach((cb) => cb(...args)),
  };
};
const operation = (value) => Object.assign(Promise.resolve(value), { cancel() {} });
const track = {
  id: 'track',
  songId: '123',
  hash: 'song',
  title: '星星',
  artist: '歌手',
  durationMs: 128000,
};
const mvHash = 'abcdef1234567890abcdef1234567890';
const request = { canceled: false, track: () => true };

function fixture() {
  const resolvers = new Map(),
    notices = [],
    changes = [],
    writes = [],
    cleared = [];
  const state = {
    hasTrack: true,
    track,
    revision: '1',
    displayState: 'playing',
    sourceNoticeCode: '',
  };
  const lyric = { revision: '1', loading: false, manual: false, lines: [] };
  const ctx = {
    ui: { registerPlayerbarActionDefinition: () => ({ update: (data) => changes.push(data) }) },
    toast: {
      info: (value) => {
        notices.push(value);
        return operation({ id: '' });
      },
    },
    player: {
      snapshot: state,
      get revision() {
        return state.revision;
      },
      audioSource: {
        registerResolver: (id, definition) => resolvers.set(id, definition),
      },
    },
    kugou: {
      request: (method, args) => {
        if (method === 'songMv') {
          assert.equal(args.mixSongId, '123');
          return operation([
            {
              audio_fallback_eligible: false,
              recommendation_code: 10,
              duration_ms: 1000,
              sources: [],
            },
            {
              audio_fallback_eligible: true,
              recommendation_code: 1,
              duration_ms: 80000,
              sources: [{ hash: mvHash, codec: 'H.264', size_bytes: 4_000_000 }],
            },
          ]);
        }
        assert.equal(method, 'videoUrl');
        assert.equal(args.hash, mvHash);
        return operation({
          url: 'https://fs.mv.web.kugou.com/video.mp4',
          backup_urls: ['https://invalid.example/video.mp4'],
        });
      },
    },
    lyrics: {
      snapshot: lyric,
      onSnapshot() {},
      write(revision, doc) {
        writes.push([revision, doc]);
        return operation();
      },
      clear(revision) {
        cleared.push(revision);
        return operation();
      },
    },
    io: {
      readValue: (key) => {
        assert.equal(key, 'mv-lyrics-' + mvHash);
        return operation({
          duration: 80000,
          matched: true,
          content: '[1000,2000]<0,2000,0>星星',
          translation: '',
          romanization: '',
          source: '酷狗 MV 匹配歌词',
        });
      },
    },
    sessionInvalidated: signal(),
    setTimer: () => ({ dispose() {} }),
    onDispose() {},
    onPlayerChanged(id, callback) {
      this.refresh = callback;
    },
  };
  activate(ctx);
  return { ctx, state, lyric, resolvers, notices, changes, writes, cleared };
}

test('关联 MV 跳过不合格条目、验证域名，并在实际播放后才应用缓存歌词', async () => {
  const f = fixture();
  const mv = f.resolvers.get('associated-mv');
  assert.equal(mv.position, 'final-fallback');
  assert.equal(mv.match({ track: { ...track, sourceId: 'custom' } }), false);
  const source = await mv.resolve({ track, request });
  assert.deepEqual(source.urls, ['https://fs.mv.web.kugou.com/video.mp4']);
  assert.equal(source.durationMs, 80000);
  assert.equal(f.notices.length, 0);
  f.state.sourceNoticeCode = source.noticeCode;
  f.ctx.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes[0][0], '1');
  assert.equal(f.writes[0][1].format, 'krc');
  assert.match(f.notices.at(-1), /已匹配 MV 歌词/);
  f.state.sourceNoticeCode = '';
  f.ctx.refresh();
  assert.deepEqual(f.cleared, ['1']);
  assert.equal(f.changes.at(-1).visible, false);
});

test('手选歌词不被替换；取消的 MV 解析不发布音源', async () => {
  const f = fixture();
  const mv = f.resolvers.get('associated-mv');
  assert.equal(await mv.resolve({ track, request: { ...request, canceled: true } }), null);
  f.lyric.manual = true;
  f.state.sourceNoticeCode = (await mv.resolve({ track, request })).noticeCode;
  f.ctx.refresh();
  assert.deepEqual(f.writes, []);
  assert.match(f.notices.at(-1), /手选歌词/);
});
