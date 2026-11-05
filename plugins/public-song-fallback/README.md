# 付费歌曲续听 · EchoMusicNext

曲库歌曲无法播放时，尝试网易云或 QQ 音乐的公开完整同曲，或使用酷狗公开关联 MV 的音轨。插件要求同一标题、完整歌手和相近时长，排除付费、试听及不确定的音源。不会改变原平台的付费权限。

MV 播放时按 MV 时长检索同版本歌词，并通过本地音频识别核验。可靠的结果才覆盖当前歌词；切回其他音源会撤回覆盖，手选歌词优先。播放栏图标悬停和 toast 显示来源及状态。

支持 EchoMusicNext 0.1.0 及具备所需 SDK 功能的后续版本。Windows x64 提供自动歌词核验；其他平台仍可使用音源兜底，当前未提供本地识别程序。首次启动核验程序须通过宿主授权。Windows N 版可能需要 Media Feature Pack。完整包约 69 MiB，模型随包提供；不上传媒体或歌词到识别服务。

插件仅在实际使用关联 MV 兜底后下载一份临时副本。Windows Media Foundation 将其音轨转换为 PCM，随包的 Whisper 识别结果用于比较候选时间轴，完成后清理临时文件。证据不足时保留原歌词。不会剪辑或替换正在播放的 MV 音轨。

插件使用 MIT 许可证；第三方组件和模型详见 [第三方说明](analysis/THIRD_PARTY_NOTICES.md)。

## 从源码构建

使用 Node 24，在仓库根目录执行 `npm ci --ignore-scripts`。从[旧版已发布源码](https://github.com/CarsonGame/EchoMusicPlugins/tree/a2a561b/public-song-fallback/bin)复制 `bin/models` 与 `bin/whisper-cpp`（也可按 `analysis/MODEL_SOURCE.json` 获取并核对 SHA-256）。在 Visual Studio x64 开发者命令提示符中执行 `plugins\public-song-fallback\native\build-windows.cmd`。随后从仓库根目录运行：

```sh
node packages/tools/cli.mjs build plugins/public-song-fallback
node packages/tools/cli.mjs validate dist/public-song-fallback-1.0.0.echomod
node --test plugins/public-song-fallback/tests/flow.test.mjs
```
