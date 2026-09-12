#if os(iOS)
import AVFoundation
import Foundation

/// Records a voice note with AVAudioRecorder (AAC in .m4a), sampling the
/// meter into a Telegram-style 0…255 waveform. Recording happens only after
/// an explicit user tap; the system microphone prompt is requested
/// contextually on the first attempt.
@MainActor
@Observable
final class PhoneVoiceRecorder {
    enum State: Equatable {
        case idle
        case recording
        case finishing
    }

    private(set) var state: State = .idle
    private(set) var elapsedSeconds: Int = 0
    private(set) var levels: [Int] = []
    private(set) var errorMessage: String?

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var startedAt: Date?
    private var outputURL: URL?

    var isRecording: Bool { state == .recording }

    func start() {
        guard state == .idle else { return }
        errorMessage = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            let granted: Bool
            if #available(iOS 17.0, *) {
                granted = await AVAudioApplication.requestRecordPermission()
            } else {
                granted = await withCheckedContinuation { continuation in
                    AVAudioSession.sharedInstance().requestRecordPermission { value in
                        continuation.resume(returning: value)
                    }
                }
            }
            guard granted else {
                self.errorMessage = "Разрешите доступ к микрофону в настройках iPhone."
                return
            }
            self.beginRecording()
        }
    }

    func stop() -> PendingMediaAttachment? {
        guard state == .recording, let recorder, let outputURL, let startedAt else { return nil }
        state = .finishing
        meterTimer?.invalidate()
        meterTimer = nil
        recorder.stop()
        let durationMs = max(1_000, Int(Date().timeIntervalSince(startedAt) * 1_000))
        guard let data = try? Data(contentsOf: outputURL), data.count > 1_024 else {
            reset()
            errorMessage = "Запись слишком короткая. Попробуйте ещё раз."
            return nil
        }
        try? FileManager.default.removeItem(at: outputURL)
        let pending = PendingMediaAttachment(
            kind: "voice",
            fileName: "voice-note.m4a",
            mimeType: "audio/mp4",
            data: data,
            durationMs: durationMs,
            waveform: Self.downsampled(levels, to: 100)
        )
        reset()
        return pending
    }

    func cancel() {
        meterTimer?.invalidate()
        recorder?.stop()
        if let outputURL { try? FileManager.default.removeItem(at: outputURL) }
        reset()
    }

    private func beginRecording() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("luxora-voice-\(UUID().uuidString.lowercased()).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.record() else {
                errorMessage = "Не удалось начать запись."
                return
            }
            self.recorder = recorder
            self.outputURL = url
            self.startedAt = Date()
            self.elapsedSeconds = 0
            self.levels = []
            self.state = .recording
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in self?.sampleMeter() }
            }
        } catch {
            errorMessage = "Микрофон недоступен. Проверьте настройки."
        }
    }

    private func sampleMeter() {
        guard let recorder, state == .recording, let startedAt else { return }
        recorder.updateMeters()
        let power = recorder.averagePower(forChannel: 0)
        let clamped = min(max((power + 50) / 50, 0), 1)
        levels.append(Int(clamped * 255))
        if levels.count > 600 { levels.removeFirst(levels.count - 600) }
        elapsedSeconds = Int(Date().timeIntervalSince(startedAt))
        if elapsedSeconds >= 3_600 {
            _ = stop()
        }
    }

    private func reset() {
        recorder = nil
        outputURL = nil
        startedAt = nil
        state = .idle
        elapsedSeconds = 0
        levels = []
    }

    static func downsampled(_ levels: [Int], to count: Int) -> [Int] {
        guard !levels.isEmpty else { return [] }
        guard levels.count > count else { return levels }
        let stride = Double(levels.count) / Double(count)
        return (0..<count).map { index in
            let start = Int(Double(index) * stride)
            let end = min(Int(Double(index + 1) * stride), levels.count)
            let slice = levels[start..<max(start + 1, end)]
            return slice.max() ?? 0
        }
    }
}
#endif
