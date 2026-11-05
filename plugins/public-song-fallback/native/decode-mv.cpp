#define NOMINMAX
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <vector>

using Microsoft::WRL::ComPtr;
constexpr unsigned outputRate = 16000;
constexpr unsigned maxSeconds = 480;

static bool writeWav(const wchar_t* path, const std::vector<int16_t>& samples) {
    FILE* file = nullptr;
    if (_wfopen_s(&file, path, L"wb")) return false;
    const uint32_t bytes = static_cast<uint32_t>(samples.size() * 2);
    const auto put = [&](uint32_t value) { fwrite(&value, 4, 1, file); };
    put(0x46464952); put(36 + bytes); put(0x45564157); put(0x20746d66); put(16);
    put(0x00010001); put(outputRate); put(outputRate * 2); put(0x00100002);
    put(0x61746164); put(bytes);
    const bool ok = fwrite(samples.data(), 2, samples.size(), file) == samples.size() && !ferror(file);
    return fclose(file) == 0 && ok;
}

static int decode(const wchar_t* input, const wchar_t* output) {
    ComPtr<IMFSourceReader> reader;
    if (FAILED(MFCreateSourceReaderFromURL(input, nullptr, &reader))) return 3;
    const DWORD stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM;
    if (FAILED(reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE)) ||
        FAILED(reader->SetStreamSelection(stream, TRUE))) return 4;

    ComPtr<IMFMediaType> type;
    if (FAILED(MFCreateMediaType(&type)) || FAILED(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio)) ||
        FAILED(type->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM)) ||
        FAILED(type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16)) ||
        FAILED(reader->SetCurrentMediaType(stream, nullptr, type.Get())) ||
        FAILED(reader->GetCurrentMediaType(stream, type.ReleaseAndGetAddressOf()))) return 5;
    UINT32 rate = 0, channels = 0, bits = 0;
    if (FAILED(type->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate)) ||
        FAILED(type->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels)) ||
        FAILED(type->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &bits)) ||
        rate < 8000 || rate > 192000 || channels == 0 || channels > 8 || bits != 16) return 6;

    std::vector<int16_t> mono;
    bool haveFirst = false;
    int64_t firstTime = 0;
    for (;;) {
        DWORD flags = 0;
        LONGLONG time = 0;
        ComPtr<IMFSample> sample;
        if (FAILED(reader->ReadSample(stream, 0, nullptr, &flags, &time, &sample)) ||
            flags & (MF_SOURCE_READERF_ERROR | MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED)) return 7;
        if (sample) {
            ComPtr<IMFMediaBuffer> buffer;
            if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return 8;
            BYTE* bytes = nullptr;
            DWORD length = 0;
            if (FAILED(buffer->Lock(&bytes, nullptr, &length))) return 9;
            if (!haveFirst) { firstTime = std::min<int64_t>(time, 0); haveFirst = true; }
            // 按媒体时钟补齐明显空隙，保留 MV 的开场偏移。
            const uint64_t start = static_cast<uint64_t>(std::max<int64_t>(0, time - firstTime)) * rate / 10000000;
            const size_t frames = length / (2 * channels);
            if (start > uint64_t(rate) * maxSeconds || mono.size() + frames > size_t(rate) * maxSeconds) {
                buffer->Unlock(); return 10;
            }
            if (start > mono.size() + rate / 50) mono.resize(static_cast<size_t>(start));
            const auto* inputSamples = reinterpret_cast<const int16_t*>(bytes);
            for (size_t i = 0; i < frames; ++i) {
                int32_t sum = 0;
                for (unsigned ch = 0; ch < channels; ++ch) sum += inputSamples[i * channels + ch];
                mono.push_back(static_cast<int16_t>(sum / static_cast<int>(channels)));
            }
            buffer->Unlock();
        }
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
    }
    if (mono.empty()) return 11;
    std::vector<int16_t> result(mono.size() * outputRate / rate);
    for (size_t i = 0; i < result.size(); ++i) {
        const uint64_t position = uint64_t(i) * rate;
        const size_t first = static_cast<size_t>(position / outputRate);
        const int remainder = static_cast<int>(position % outputRate);
        const int left = mono[first], right = mono[std::min(first + 1, mono.size() - 1)];
        result[i] = static_cast<int16_t>(left + (right - left) * remainder / static_cast<int>(outputRate));
    }
    return writeWav(output, result) ? 0 : 12;
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 3 || FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 2;
    const HRESULT startup = MFStartup(MF_VERSION);
    const int result = SUCCEEDED(startup) ? decode(argv[1], argv[2]) : 2;
    if (SUCCEEDED(startup)) MFShutdown();
    CoUninitialize();
    return result;
}
