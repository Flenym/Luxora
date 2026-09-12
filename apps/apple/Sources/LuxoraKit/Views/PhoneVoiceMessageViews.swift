#if os(iOS)
import AVFoundation
import SwiftUI

/// Telegram-style voice bubble: play/pause, waveform bars and duration.
struct PhoneVoiceMessageView: View {
    let attachment: MessageAttachment
    let cache: AuthenticatedAvatarImageCache?

    @State private var player: AVAudioPlayer?
    @State private var isPlaying = false
    @State private var progress: Double = 0
    @State private var failed = false
    @State private var progressTimer: Timer?

    private var bars: [Int] {
        if let waveform = attachment.waveform, !waveform.isEmpty {
            Array(waveform.prefix(64))
        } else {
            Array(repeating: 96, count: 24)
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                toggle()
            } label: {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 40, height: 40)
                    .foregroundStyle(.white)
                    .background(LuxoraTheme.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(failed)
            .accessibilityLabel(isPlaying ? "Пауза" : "Слушать голосовое")
            .accessibilityIdentifier("voice-message-play")

            VStack(alignment: .leading, spacing: 5) {
                PhoneWaveformBars(values: bars, progress: progress)
                    .frame(height: 28)
                Text(statusText)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Голосовое сообщение, \(statusText)")
        .accessibilityIdentifier("voice-message-bubble")
        .onDisappear(perform: stop)
    }

    private var statusText: String {
        if failed { return "Не удалось загрузить" }
        return attachment.formattedDuration ?? attachment.formattedSize
    }

    private func toggle() {
        if isPlaying { stop(); return }
        Task { await play() }
    }

    private func play() async {
        failed = false
        do {
            let data: Data
            if let cached = await PhoneVoiceDataCache.shared.data(for: attachment) {
                data = cached
            } else {
                guard let cache else { throw LuxoraVoiceCacheError.unavailable }
                data = try await cache.data(for: attachment.downloadPath)
                await PhoneVoiceDataCache.shared.insert(data, for: attachment)
            }
            let player = try AVAudioPlayer(data: data)
            player.prepareToPlay()
            player.play()
            self.player = player
            isPlaying = true
            progressTimer?.invalidate()
            progressTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
                Task { @MainActor in
                    guard let player, player.duration > 0 else { return }
                    progress = player.currentTime / player.duration
                    if !player.isPlaying { stop() }
                }
            }
        } catch {
            failed = true
        }
    }

    private func stop() {
        progressTimer?.invalidate()
        progressTimer = nil
        player?.stop()
        player = nil
        isPlaying = false
        progress = 0
    }
}

private enum LuxoraVoiceCacheError: Error {
    case unavailable
}

/// Small in-memory cache so replaying a voice note does not refetch bytes.
@MainActor
private final class PhoneVoiceDataCache {
    static let shared = PhoneVoiceDataCache()
    private var entries: [String: Data] = [:]
    private var order: [String] = []

    func data(for attachment: MessageAttachment) -> Data? {
        entries[attachment.id.uuidString]
    }

    func insert(_ data: Data, for attachment: MessageAttachment) {
        let key = attachment.id.uuidString
        entries[key] = data
        order.append(key)
        var total = entries.values.reduce(0) { $0 + $1.count }
        while total > 32 * 1_024 * 1_024, let oldest = order.first {
            order.removeFirst()
            total -= entries.removeValue(forKey: oldest)?.count ?? 0
        }
    }
}

struct PhoneWaveformBars: View {
    let values: [Int]
    let progress: Double

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 2) {
                ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                    let fraction = Double(index + 1) / Double(max(1, values.count))
                    Capsule()
                        .fill(fraction <= progress ? LuxoraTheme.accent : Color.secondary.opacity(0.35))
                        .frame(width: 3, height: max(4, geometry.size.height * CGFloat(value) / 255))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Inline recording bar shown above the composer while capturing.
struct PhoneVoiceRecordingBar: View {
    let elapsedSeconds: Int
    let levels: [Int]
    let onStop: () -> Void
    let onCancel: () -> Void

    private var elapsedText: String {
        String(format: "%d:%02d", elapsedSeconds / 60, elapsedSeconds % 60)
    }

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(Color.red)
                .frame(width: 10, height: 10)
            Text(elapsedText)
                .font(.callout.weight(.semibold))
                .monospacedDigit()
            PhoneWaveformBars(values: Array(levels.suffix(48)), progress: 1)
                .frame(height: 24)
            Spacer(minLength: 4)
            Button(role: .destructive, action: onCancel) {
                Image(systemName: "trash")
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("voice-record-cancel")
            Button(action: onStop) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(LuxoraTheme.accent)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("voice-record-stop")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-recording-bar")
    }
}
#endif
