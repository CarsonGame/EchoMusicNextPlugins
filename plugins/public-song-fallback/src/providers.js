// @ts-nocheck
// 复用旧版匿名完整音源筛选，网络与取消由 Next 作用域提供。
// 按用户要求，匹配和网络数值暂时集中写在代码中。
const SETTINGS = Object.freeze({
  requestTimeoutMs: 6000,
  resolveTimeoutMs: 18000,
  searchLimit: 15,
  candidateLimit: 3,
  durationMinToleranceSeconds: 3,
  durationMaxToleranceSeconds: 8,
  durationToleranceRatio: 0.02,
  minMediaSizeRatio: 0.9,
  searchCacheMs: 300000,
  searchCacheEntries: 128,
  apiMaxBytes: 1048576,
  standardBitrate: 128000,
  resolverOrder: 1000,
  alignmentTimeoutMs: 90000,
  maxAutoOffsetMs: 180000,
  mvLyricCandidateLimit: 3,
  mvLyricDurationToleranceMs: 1500,
});

const PROVIDERS = [
  { id: 'netease', label: '网易云', search: searchNetease, resolve: resolveNetease },
  { id: 'qq', label: 'QQ 音乐', search: searchQQ, resolve: resolveQQ },
];

// 只忽略排版差异，保留 Live、翻唱、伴奏等版本信息。
export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(
      /&(?:amp|quot|apos|lt|gt);/g,
      (text) =>
        ({
          '&amp;': '&',
          '&quot;': '"',
          '&apos;': "'",
          '&lt;': '<',
          '&gt;': '>',
        })[text],
    )
    .replace(/[\s\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e\u2000-\u206f\u3000-\u303f]/g, '');
}

function artistNames(track) {
  const list = track.artists ?? track.singers;
  if (Array.isArray(list) && list.length) {
    return list.map((artist) => (typeof artist === 'string' ? artist : artist.name));
  }
  return String(track.artist ?? '').split(/\s*(?:、|\/|&|;|；|,|，|\bfeat\.?\s|\bft\.\s)\s*/i);
}

function artistKey(names) {
  return [...new Set(names.map(normalize).filter(Boolean))].sort().join('|');
}

export function readTrack(track) {
  return {
    title: String(track.name || track.title || '').trim(),
    artists: artistNames(track),
    duration: Number(track.duration), // EchoMusic Song.duration 使用秒。
    album: String(track.albumName || track.album || ''),
  };
}

function hasMetadata(track) {
  return (
    Boolean(normalize(track.title) && artistKey(track.artists)) &&
    Number.isFinite(track.duration) &&
    track.duration > 0
  );
}

function durationTolerance(duration) {
  return Math.min(
    SETTINGS.durationMaxToleranceSeconds,
    Math.max(SETTINGS.durationMinToleranceSeconds, duration * SETTINGS.durationToleranceRatio),
  );
}

export function matchCandidate(track, candidate) {
  if (!hasMetadata(track) || !hasMetadata(candidate)) return false;
  return (
    normalize(track.title) === normalize(candidate.title) &&
    artistKey(track.artists) === artistKey(candidate.artists) &&
    Math.abs(track.duration - candidate.duration) <= durationTolerance(track.duration)
  );
}

export function neteaseCandidate(song) {
  return {
    id: song.id,
    title: song.name,
    artists: (song.artists ?? []).map((artist) => artist.name),
    duration: Number(song.duration) / 1000,
    album: song.album?.name ?? '',
    fee: song.fee,
  };
}

export function qqCandidate(song) {
  return {
    id: song.songmid,
    mediaId: song.media_mid || song.strMediaMid,
    title: song.songname,
    artists: (song.singer ?? []).map((artist) => artist.name),
    duration: Number(song.interval),
    album: song.albumname ?? '',
    pay: song.pay,
    size: Number(song.size128),
  };
}

export function isFreeNetease(fee) {
  // 0 为免费，8 的标准音质可免费听；仍需核验播放接口和试听字段。
  return fee === 0 || fee === 8;
}

export function isFreeQQ(candidate) {
  return (
    candidate.pay?.payplay === 0 &&
    candidate.pay?.payalbum === 0 &&
    /^[a-zA-Z0-9]+$/.test(candidate.id) &&
    /^[a-zA-Z0-9]+$/.test(candidate.mediaId) &&
    candidate.size > 0
  );
}

export function mediaUrl(value, provider) {
  const match = /^https?:\/\/([a-z0-9.-]+)(\/[^\s\\]*)$/i.exec(String(value));
  if (!match) return null;
  const host = match[1].toLowerCase();
  const allowed =
    provider === 'netease'
      ? host.endsWith('.music.126.net')
      : host === 'aqqmusic.tc.qq.com' || host.endsWith('.stream.qqmusic.qq.com');
  return allowed ? `https://${host}${match[2]}` : null;
}

async function request(runtime, options, signal) {
  const response = await runtime.request({
    ...options,
    timeoutMs: 2000,
    maxResponseBytes: SETTINGS.apiMaxBytes,
    responseType: options.responseType || 'json',
  });
  if (response.status < 200 || response.status >= 300 || signal.aborted)
    throw new Error('平台请求失败');
  return response;
}

function queryUrl(base, params) {
  return `${base}?${Object.keys(params)
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join('&')}`;
}

async function searchNetease(runtime, track, signal) {
  const { data } = await request(
    runtime,
    {
      url: queryUrl('https://music.163.com/api/search/get', {
        s: `${track.title} ${track.artists.join(' ')}`,
        type: 1,
        limit: SETTINGS.searchLimit,
        offset: 0,
      }),
    },
    signal,
  );
  if (data.code !== 200 || !Array.isArray(data.result?.songs)) return [];
  return data.result.songs.map(neteaseCandidate).filter((song) => isFreeNetease(song.fee));
}

async function searchQQ(runtime, track, signal) {
  const { data } = await request(
    runtime,
    {
      url: queryUrl('https://c.y.qq.com/soso/fcgi-bin/client_search_cp', {
        w: `${track.title} ${track.artists.join(' ')}`,
        format: 'json',
        p: 1,
        n: SETTINGS.searchLimit,
      }),
    },
    signal,
  );
  if (data.code !== 0 || !Array.isArray(data.data?.song?.list)) return [];
  return data.data.song.list.map(qqCandidate).filter(isFreeQQ);
}

export function validNeteasePlayback(item, candidate) {
  return (
    item?.code === 200 &&
    item.id === candidate.id &&
    isFreeNetease(item.fee) &&
    item.freeTrialInfo === null &&
    !item.freeTrialPrivilege?.resConsumable &&
    !item.freeTrialPrivilege?.userConsumable &&
    !item.freeTimeTrialPrivilege?.resConsumable &&
    !item.freeTimeTrialPrivilege?.userConsumable &&
    Number(item.size) > 0 &&
    Number(item.br) > 0 &&
    Math.abs(Number(item.time) / 1000 - candidate.duration) <= durationTolerance(candidate.duration)
  );
}

// 仅探测响应头，不下载整首歌曲；文件大小必须符合完整音源。
async function verifyMedia(runtime, rawUrl, provider, expectedSize, signal) {
  const url = mediaUrl(rawUrl, provider);
  if (!url) return null;
  const response = await request(
    runtime,
    { url, method: 'HEAD', responseType: 'text', maxRedirects: 3 },
    signal,
  );
  if (!mediaUrl(response.url || url, provider)) return null;
  const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
  const size = Number(response.headers['content-length']);
  const isAudio =
    contentType.startsWith('audio/') || contentType.startsWith('application/octet-stream');
  return isAudio && Number.isFinite(size) && size >= expectedSize * SETTINGS.minMediaSizeRatio
    ? url
    : null;
}

async function resolveNetease(runtime, candidate, signal) {
  const { data } = await request(
    runtime,
    {
      url: queryUrl('https://music.163.com/api/song/enhance/player/url', {
        ids: JSON.stringify([candidate.id]),
        br: SETTINGS.standardBitrate,
      }),
    },
    signal,
  );
  const item = Array.isArray(data.data) ? data.data.find((song) => song.id === candidate.id) : null;
  if (!validNeteasePlayback(item, candidate)) return null;
  return verifyMedia(runtime, item.url, 'netease', Number(item.size), signal);
}

async function resolveQQ(runtime, candidate, signal) {
  const filename = `M500${candidate.mediaId}.mp3`;
  const body = {
    comm: { ct: 24, cv: 0, uin: 0, format: 'json' },
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: '1000000000',
        songmid: [candidate.id],
        songtype: [0],
        filename: [filename],
        uin: '0',
        loginflag: 0,
        platform: '20',
      },
    },
  };
  const { data } = await request(
    runtime,
    {
      url: queryUrl('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        data: JSON.stringify(body),
      }),
    },
    signal,
  );
  const result = data.req_0?.data;
  const item = result?.midurlinfo?.find((song) => song.songmid === candidate.id);
  if (
    data.code !== 0 ||
    data.req_0?.code !== 0 ||
    result?.retcode !== 0 ||
    item?.result !== 0 ||
    item.pneedbuy !== 0 ||
    item.pneed !== 0 ||
    item.filename !== filename ||
    !String(item.purl).startsWith(`${filename}?`)
  )
    return null;
  // 不使用 opi30surl 等试听地址，只接收匿名接口返回的完整文件。
  for (const base of result.sip ?? []) {
    const url = mediaUrl(String(base).replace(/\/?$/, '/') + item.purl, 'qq');
    if (!url) continue;
    try {
      const verified = await verifyMedia(runtime, url, 'qq', candidate.size, signal);
      if (verified) return verified;
    } catch {
      if (signal.aborted) return null;
    }
  }
  return null;
}

function trackKey(track) {
  return JSON.stringify([normalize(track.title), artistKey(track.artists), track.duration]);
}

async function providerMatch(runtime, provider, track, signal) {
  const key = `${provider.id}:${trackKey(track)}`;
  let cached = runtime.cache.get(key);
  if (!cached || cached.expires <= Date.now()) {
    const songs = await provider.search(runtime, track, signal);
    cached = { songs, expires: Date.now() + SETTINGS.searchCacheMs };
    runtime.cache.delete(key);
    runtime.cache.set(key, cached);
    if (runtime.cache.size > SETTINGS.searchCacheEntries)
      runtime.cache.delete(runtime.cache.keys().next().value);
  }
  const candidates = cached.songs
    .filter((song) => matchCandidate(track, song))
    .sort(
      (a, b) =>
        Number(normalize(b.album) === normalize(track.album)) -
          Number(normalize(a.album) === normalize(track.album)) ||
        Math.abs(a.duration - track.duration) - Math.abs(b.duration - track.duration),
    )
    .slice(0, SETTINGS.candidateLimit);
  for (const candidate of candidates) {
    if (signal.aborted) return null;
    try {
      // 只缓存搜索元数据，每次重新获取短期有效的播放地址。
      const url = await provider.resolve(runtime, candidate, signal);
      if (url) return { url, provider: provider.label, candidate };
    } catch {
      if (signal.aborted) return null;
    }
  }
  return null;
}

// 按宿主解析预算并行取最快的完整音源，后续未用请求由作用域撤销。
export function findPublicMatch(runtime, track, signal) {
  const metadata = readTrack({
    ...track,
    name: track.title,
    duration: Number(track.durationMs) / 1000,
  });
  if (!hasMetadata(metadata) || !track.hash || track.sourceId) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = PROVIDERS.length;
    for (const provider of PROVIDERS)
      providerMatch(runtime, provider, metadata, signal).then(
        (result) => {
          if (result && !signal.aborted) resolve(result);
          if (!--pending) resolve(null);
        },
        () => {
          if (!--pending) resolve(null);
        },
      );
  });
}
