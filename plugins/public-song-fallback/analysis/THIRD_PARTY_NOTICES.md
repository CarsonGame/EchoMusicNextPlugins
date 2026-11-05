# 轻量本地识别组件

本插件使用 whisper.cpp 原生 CPU 程序和 Base Q5_1 多语言量化模型。Next 版通过本包的 `decode-mv.exe` 调用 Windows Media Foundation 提取音轨；程序源码位于发布仓库的 `native/decode-mv.cpp`。不分发 Python、FFmpeg 或 Whisper small 模型。

- whisper.cpp b5454，MIT：https://github.com/ggml-org/whisper.cpp/releases/tag/b5454
- ggml，MIT：https://github.com/ggml-org/ggml
- Whisper Base 模型，MIT：https://huggingface.co/ggerganov/whisper.cpp
- Whisper 原项目，MIT：https://github.com/openai/whisper
- Silero VAD 6.2.0，MIT：https://huggingface.co/ggml-org/whisper-vad
- OpenCC 繁简转换词典，Apache 2.0：https://github.com/BYVoid/OpenCC 。使用已有 opencc-python-reimplemented 0.1.7 随附词典生成静态 JavaScript 映射，不分发 Python 运行库。

下载地址、版本和 SHA-256 见 `MODEL_SOURCE.json`，许可证见 `licenses/`。CLI 及 DLL 未修改，均来自官方 `whisper-bin-x64.zip`；只保留 CLI、Whisper/ggml 核心与 CPU 后端，没有打包测试程序、服务器、SDL、CUDA 或其他模型。

官方 Windows CPU 程序依赖 Microsoft Visual C++ x64 运行库。若系统缺少运行库，需安装微软官方对应运行库。发布前已通过实际启动、解码及识别测试。
