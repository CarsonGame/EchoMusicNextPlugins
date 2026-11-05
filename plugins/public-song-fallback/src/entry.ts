import { awaitOperation } from 'echo:plugin-sdk';
import type {
  AudioSourceContext,
  AudioSourceValue,
  EchoPluginContext,
  EchoPluginDownload,
  EchoPluginOperation,
  FileReference,
  JsonValue,
  LyricDocument,
  LyricSourceSnapshot,
  PlaybackSnapshot,
  PluginProcessInfo,
  QueueTrack,
  KugouMethods,
} from 'echo:plugin-sdk';
import { findPublicMatch, normalize, mediaUrl } from './providers.js';
import { alignRecognizedWords, whisperWords } from './alignment.js';

declare const Qt: { platform?: { os?: string } } | undefined;
const lyricTolerance = 1500;
const maxAnalysisMs = 90000;
const maxMediaBytes = 128 * 1024 * 1024;
const noticePrefix = 'public-song-fallback:';
type Pending = { cancel(): void };
type MV = { url: string; hash: string; duration: number; alternatives: string[] };
type Line = {
  text: string;
  timeMs: number;
  end: number;
  estimated: boolean;
  characters: { text: string; startTime: number; endTime: number }[];
  translation: string;
  romanization: string;
};
type Target = { lines: Line[]; source: string; mv: boolean };
type Candidate = KugouMethods['lyricCandidatesByKeywords']['result'][number];

function trustedMV(url: string) {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*kugou\.(?:com|net)\/[^\s\\]*$/i.test(url);
}

function safeText(text: string) {
  return text.replace(/[\r\n\x00-\x1f]/g, ' ').replace(/[\[\]<>()]/g, '');
}

function stamp(value: number) {
  const time = Math.max(0, Math.round(value));
  const pad = (n: number, width: number) => ('000' + String(n)).slice(-width);
  return (
    '[' +
    pad(Math.floor(time / 60000), 2) +
    ':' +
    pad(Math.floor(time / 1000) % 60, 2) +
    '.' +
    pad(time % 1000, 3) +
    ']'
  );
}

function lyricDocument(target: Target, offset: number): LyricDocument {
  const lines = target.lines.filter((line) => line.end + offset > 0);
  return {
    format: 'krc',
    source: target.source,
    content: lines
      .map((line) => {
        const start = Math.max(0, Math.round(line.timeMs + offset));
        const header = '[' + start + ',' + Math.max(1, Math.round(line.end + offset) - start) + ']';
        return (
          header +
          (line.estimated
            ? safeText(line.text)
            : line.characters
                .map((word) => {
                  const at = Math.max(0, Math.round(word.startTime + offset) - start);
                  const end = Math.max(at + 1, Math.round(word.endTime + offset) - start);
                  return '<' + at + ',' + (end - at) + ',0>' + safeText(word.text);
                })
                .join(''))
        );
      })
      .join('\n'),
    translation: lines
      .filter((line) => line.translation)
      .map((line) => stamp(line.timeMs + offset) + safeText(line.translation))
      .join('\n'),
    romanization: lines
      .filter((line) => line.romanization)
      .map((line) => stamp(line.timeMs + offset) + safeText(line.romanization))
      .join('\n'),
  };
}

function closeMatch(track: QueueTrack, item: Candidate, duration: number) {
  const artists = (text: string) =>
    text
      .split(/[、/&;,，；]/)
      .map(normalize)
      .filter(Boolean)
      .sort()
      .join('|');
  return (
    !!item.source_id &&
    !!item.access_key &&
    !!normalize(track.title) &&
    !!artists(track.artist || '') &&
    normalize(track.title) === normalize(item.title) &&
    artists(track.artist || '') === artists(item.artist) &&
    item.duration_ms !== null &&
    Math.abs(item.duration_ms - duration) <= lyricTolerance
  );
}

function referenceLines(snapshot: LyricSourceSnapshot): Line[] {
  return snapshot.lines
    .filter((line) => !line.filtered && line.lineText.trim())
    .map((line) => ({
      text: line.lineText,
      timeMs: line.startMs,
      end: line.startMs + line.durationMs,
      estimated: !line.wordTimed,
      characters: line.words.reduce<Line['characters']>((words, value) => {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          typeof value.text === 'string' &&
          typeof value.start_ms === 'number' &&
          typeof value.duration_ms === 'number'
        ) {
          words.push({
            text: value.text,
            startTime: value.start_ms,
            endTime: value.start_ms + value.duration_ms,
          });
        }
        return words;
      }, []),
      translation: line.translation,
      romanization: line.romanization,
    }))
    .map((line) => ({ ...line, estimated: line.estimated || !line.characters.length }));
}

export function activate(ctx: EchoPluginContext) {
  const searchCache = new Map();
  const media = new Map<string, MV>();
  let sequence = 0;
  let activeKey = '';
  let announced = '';
  let overlayRevision = '';
  let running: { cancel(): void } | undefined;
  let disposed = false;
  const action = ctx.ui.registerPlayerbarActionDefinition('fallback-source-status', {
    title: '续听状态',
    icon: 'music',
    tooltip: '',
    defaultPlacement: 'left',
    visible: false,
    trigger: 'hover',
    onClick() {},
  });

  const show = (status: string, label: string, key: string) => {
    const message = '来自' + label + '兜底' + (status ? '，' + status : '');
    action?.update({ visible: true, tooltip: message });
    const token = key + ':' + status;
    if (token !== announced) {
      announced = token;
      void awaitOperation(ctx.toast.info(message)).catch(() => {});
    }
  };

  function fromResolver<T>(
    request: AudioSourceContext['request'],
    operation: EchoPluginOperation<T>,
  ) {
    request.track(operation);
    return awaitOperation(operation);
  }

  ctx.player.audioSource.registerResolver('public-song', {
    position: 'after-catalog',
    match: ({ track }) => !!track.hash && !track.sourceId,
    async resolve({ track, request, forceReload }) {
      if (forceReload) searchCache.clear();
      const result = await findPublicMatch(
        {
          cache: searchCache,
          request: (options: Parameters<typeof ctx.net.request>[0]) =>
            fromResolver(request, ctx.net.request(options)),
        },
        track,
        {
          get aborted() {
            return request.canceled;
          },
        },
      );
      if (!result || request.canceled) return null;
      const service = mediaUrl(result.url, 'netease') ? '网易云' : 'QQ 音乐';
      return {
        url: result.url,
        quality: 'standard',
        effect: 'none',
        sourceKind: 'plugin',
        noticeCode: noticePrefix + service,
      };
    },
  });

  ctx.player.audioSource.registerResolver('associated-mv', {
    position: 'final-fallback',
    match: ({ track }) => !!track.hash && !track.sourceId && /^[1-9]\d*$/.test(track.songId || ''),
    async resolve({ track, request }): Promise<AudioSourceValue | null> {
      const videos = await fromResolver(
        request,
        ctx.kugou.request('songMv', { mixSongId: track.songId || '' }),
      );
      const video = videos
        .filter(
          (item) =>
            item.audio_fallback_eligible === true &&
            Number(item.duration_ms) > 0 &&
            item.sources.length,
        )
        .sort((a, b) => Number(b.recommendation_code) - Number(a.recommendation_code))[0];
      if (!video || request.canceled) return null;
      // 优先 MP4；Windows 解码程序不需要解码视频轨。
      const sources = video.sources
        .filter(
          (item) =>
            /^[0-9a-f]{32}$/i.test(item.hash) && /h\.?26[45]|avc|hevc|mp4/i.test(item.codec),
        )
        .sort((a, b) => (a.size_bytes || Infinity) - (b.size_bytes || Infinity));
      const results = await Promise.all(
        sources.slice(0, 2).map(async (source) => {
          try {
            const result = await fromResolver(
              request,
              ctx.kugou.request('videoUrl', { hash: source.hash }),
            );
            const urls = result ? [result.url, ...result.backup_urls].filter(trustedMV) : [];
            return urls.length ? { source, urls } : null;
          } catch {
            return null;
          }
        }),
      );
      const selected = results.find((item) => item !== null);
      if (!selected || request.canceled) return null;
      const { source, urls } = selected;
      if (!urls.length) return null;
      const code = noticePrefix + 'mv:' + String(++sequence);
      media.set(code, {
        url: urls[0],
        hash: source.hash,
        duration: Number(video.duration_ms),
        alternatives: urls.slice(1),
      });
      if (media.size > 128) {
        const oldest = media.keys().next().value;
        if (oldest) media.delete(oldest);
      }
      return {
        urls,
        effect: 'none',
        sourceKind: 'plugin',
        durationMs: Number(video.duration_ms),
        noticeCode: code,
      };
    },
  });

  async function analyze(
    snapshot: PlaybackSnapshot,
    mv: MV,
    lyrics: LyricSourceSnapshot,
    key: string,
  ) {
    const pending = new Set<Pending>();
    const processIds = new Set<string>();
    let cancelled = false;
    let timedOut = false;
    let transfer: EchoPluginDownload | undefined;
    const isCurrent = () =>
      !disposed && !cancelled && activeKey === key && ctx.player.revision === snapshot.revision;
    const check = () => {
      if (!isCurrent()) throw new Error('stale');
    };
    const wait = async <T>(operation: EchoPluginOperation<T>, retain?: (value: T) => void) => {
      pending.add(operation);
      try {
        const value = await awaitOperation(operation);
        retain?.(value);
        check();
        return value;
      } finally {
        pending.delete(operation);
      }
    };
    const cancel = () => {
      cancelled = true;
      for (const operation of pending) operation.cancel();
      if (transfer) void awaitOperation(transfer.cancel()).catch(() => {});
      for (const id of processIds) void awaitOperation(ctx.process.terminate(id)).catch(() => {});
    };
    const task = { cancel };
    running = task;
    const stampId = String(++sequence);
    const timer = ctx.setTimer('mv-timeout-' + stampId, maxAnalysisMs, false, () => {
      timedOut = true;
      cancel();
      if (!disposed && activeKey === key) show('歌词未校准（分析超时）', '酷狗 MV', key);
    });
    const cacheKey = 'mv-lyrics-' + mv.hash.toLowerCase();
    const files: FileReference[] = [];
    const cleanup = () =>
      files.forEach((file) => void awaitOperation(ctx.files.deleteFile(file)).catch(() => {}));

    async function process(executable: string, args: string[], id: string) {
      let child = '';
      const early = new Map<string, PluginProcessInfo>();
      let resolveExit: (value: PluginProcessInfo) => void = () => {};
      let rejectExit: (reason: Error) => void = () => {};
      const exit = new Promise<PluginProcessInfo>((resolve, reject) => {
        resolveExit = resolve;
        rejectExit = reject;
      });
      // 监听先于启动，避免短进程退出后才注册事件。
      const onExit = (info: PluginProcessInfo) => {
        if (!child) early.set(info.id, info);
        else if (info.id === child) resolveExit(info);
      };
      const stop = { cancel: () => rejectExit(new Error('process-cancelled')) };
      ctx.process.exited.connect(onExit);
      pending.add(stop);
      void exit.catch(() => {});
      try {
        await wait(ctx.process.launch({ executable, args }), (info) => {
          child = info.id;
          processIds.add(child);
          if (!isCurrent()) void awaitOperation(ctx.process.terminate(child)).catch(() => {});
        });
        const done = early.get(child) || (await exit);
        if (done.crashed || done.exitCode !== 0) throw new Error(id + '-' + done.exitCode);
        check();
      } finally {
        if (child) processIds.delete(child);
        pending.delete(stop);
        ctx.process.exited.disconnect(onExit);
      }
    }

    async function candidates(): Promise<Target[]> {
      try {
        const track = snapshot.track;
        const matches = await wait(
          ctx.kugou.request('lyricCandidatesByKeywords', {
            keywords: track.title + ' ' + track.artist,
            durationMs: mv.duration,
            allCandidates: true,
          }),
        );
        const list = matches
          .filter((item) => closeMatch(track, item, mv.duration))
          .sort(
            (a, b) =>
              Math.abs(Number(a.duration_ms) - mv.duration) -
              Math.abs(Number(b.duration_ms) - mv.duration),
          )
          .slice(0, 3);
        const results = await Promise.all(
          list.map(async (item) => {
            try {
              const doc = await wait(
                ctx.kugou.request('lyric', { id: item.source_id, accessKey: item.access_key }),
              );
              const lines = doc.lines.map((line) => ({
                text: line.text,
                timeMs: line.start_ms,
                end: line.start_ms + line.duration_ms,
                estimated: !line.words.length,
                translation: line.translation,
                romanization: line.romanization,
                characters: line.words.map((word) => ({
                  text: word.text,
                  startTime: word.start_ms,
                  endTime: word.start_ms + word.duration_ms,
                })),
              }));
              if (
                !doc.scrollable ||
                lines.length < 4 ||
                lines.some(
                  (line, index) =>
                    line.timeMs < 0 ||
                    line.end > mv.duration + lyricTolerance ||
                    line.end < line.timeMs ||
                    (index > 0 && line.timeMs < lines[index - 1].timeMs) ||
                    line.characters.some(
                      (word) =>
                        word.startTime < line.timeMs || word.endTime > mv.duration + lyricTolerance,
                    ),
                )
              )
                return null;
              return { lines, source: '酷狗 MV 匹配歌词', mv: true };
            } catch {
              return null;
            }
          }),
        );
        return results.filter((item): item is Target => item !== null);
      } catch {
        return [];
      }
    }

    const apply = async (document: LyricDocument, matched: boolean) => {
      check();
      overlayRevision = lyrics.revision;
      await wait(ctx.lyrics.write(lyrics.revision, document));
      show(matched ? '已匹配 MV 歌词' : '歌词已自动校准', '酷狗 MV', key);
    };

    try {
      show('检索 MV 歌词中', '酷狗 MV', key);
      const cached = await wait(ctx.io.readValue(cacheKey));
      if (
        cached &&
        typeof cached === 'object' &&
        !Array.isArray(cached) &&
        typeof cached.content === 'string' &&
        typeof cached.source === 'string' &&
        typeof cached.translation === 'string' &&
        typeof cached.romanization === 'string' &&
        cached.duration === mv.duration
      ) {
        await apply(
          {
            format: 'krc',
            content: cached.content,
            translation: cached.translation,
            romanization: cached.romanization,
            source: cached.source,
          },
          cached.matched === true,
        );
        return;
      }
      const alternatives = await candidates();
      check();
      const targets: Target[] = [
        ...alternatives,
        { lines: referenceLines(lyrics), source: 'MV 自动校准', mv: false },
      ];
      if (!targets.some((item) => item.lines.length >= 4)) {
        show('未找到可核验歌词', '酷狗 MV', key);
        return;
      }
      show('歌词自动校准中', '酷狗 MV', key);
      const grant = await wait(ctx.files.privateDirectory('cache'));
      const base = 'mv-' + Date.now() + '-' + stampId;
      const ref = (suffix: string): FileReference => ({ ...grant.file, path: base + suffix });
      const path = (suffix: string) => grant.displayPath + '/' + base + suffix;
      const video = ref('.mp4'),
        wav = ref('.wav'),
        output = ref('.json');
      files.push(video, wav, output);
      let downloaded = false;
      for (const url of [mv.url, ...mv.alternatives]) {
        try {
          const download = await wait(
            ctx.downloads.start({
              url,
              target: video,
              name: 'MV 歌词核验',
              conflict: 'replace',
              resume: false,
              lifetime: 'track',
              maxBytes: maxMediaBytes,
            }),
            (value) => {
              transfer = value;
              if (!isCurrent()) void awaitOperation(value.cancel()).catch(() => {});
            },
          );
          await wait(download.wait());
          downloaded = true;
          break;
        } catch {
          check();
        } finally {
          if (transfer) void awaitOperation(ctx.downloads.remove(transfer.id)).catch(() => {});
          transfer = undefined;
        }
      }
      if (!downloaded) throw new Error('mv-download-failed');
      await process('bin/decode-mv.exe', [path('.mp4'), path('.wav')], 'decode');
      const content = targets[0].lines.map((line) => line.text).join('');
      const lang = /[\u3040-\u30ff]/.test(content)
        ? 'ja'
        : /[\uac00-\ud7af]/.test(content)
          ? 'ko'
          : /[\u4e00-\u9fff]/.test(content)
            ? 'zh'
            : 'auto';
      await process(
        'bin/whisper-cpp/whisper-cli.exe',
        [
          '-m',
          'bin/models/ggml-base-q5_1.bin',
          '-f',
          path('.wav'),
          '-of',
          path(''),
          '-l',
          lang,
          '-t',
          '2',
          '-bs',
          '1',
          '-bo',
          '1',
          '-nf',
          '-ng',
          '-ojf',
          '-ml',
          '1',
          '-np',
        ],
        'recognize',
      );
      const json = await wait(ctx.files.readText(output, { maxBytes: 1024 * 1024 }));
      if (json.truncated) throw new Error('recognition-output-too-large');
      const words = whisperWords(JSON.parse(json.text), 0);
      for (const target of targets) {
        const result = alignRecognizedWords(target.lines, words);
        if (!result.ok || typeof result.offsetMs !== 'number' || !Number.isFinite(result.offsetMs))
          continue;
        const document = lyricDocument(target, result.offsetMs);
        await apply(document, target.mv);
        // 仅缓存已通过核验的替代歌词，避免复用另一份原歌词的偏移。
        if (target.mv)
          void awaitOperation(
            ctx.io.writeValue(cacheKey, {
              ...document,
              duration: mv.duration,
              matched: true,
            } as JsonValue),
          ).catch(() => {});
        return;
      }
      show('歌词未校准（匹配证据不足）', '酷狗 MV', key);
    } catch (error) {
      if (isCurrent() && !timedOut) {
        console.warn('MV 歌词核验未完成', String(error));
        show('歌词未校准（本地分析未完成）', '酷狗 MV', key);
      }
    } finally {
      timer?.dispose();
      cleanup();
      if (running === task) running = undefined;
    }
  }

  function update() {
    const playback = ctx.player.snapshot;
    const lyric = ctx.lyrics.snapshot;
    const code = playback.sourceNoticeCode || '';
    const label = code.slice(noticePrefix.length);
    const mv = media.get(code);
    const key =
      playback.hasTrack && code.startsWith(noticePrefix) ? playback.revision + ':' + code : '';
    if (!key || (activeKey && activeKey !== key)) {
      running?.cancel();
      const previous = overlayRevision;
      overlayRevision = '';
      if (previous && previous === lyric.revision)
        void awaitOperation(ctx.lyrics.clear(previous)).catch(() => {});
      activeKey = '';
      announced = '';
      action?.update({ visible: false });
    }
    if (!key || activeKey || !['playing', 'paused'].includes(playback.displayState)) return;
    if (mv && lyric.loading) return;
    activeKey = key;
    if (!mv) {
      show('', label, key);
      return;
    }
    if (lyric.manual) {
      show('保留手选歌词', '酷狗 MV', key);
      return;
    }
    if (typeof Qt !== 'undefined' && Qt?.platform?.os && Qt.platform.os !== 'windows') {
      show('当前平台不支持本地歌词核验', '酷狗 MV', key);
      return;
    }
    void analyze(playback, mv, lyric, key);
  }

  ctx.onPlayerChanged('fallback-playback', update);
  ctx.lyrics.onSnapshot('fallback-lyrics', update, false);
  const resetSession = () => {
    running?.cancel();
    media.clear();
    searchCache.clear();
    activeKey = '';
  };
  ctx.sessionInvalidated.connect(resetSession);
  ctx.onDispose(() => {
    disposed = true;
    resetSession();
    ctx.sessionInvalidated.disconnect(resetSession);
  });
}
