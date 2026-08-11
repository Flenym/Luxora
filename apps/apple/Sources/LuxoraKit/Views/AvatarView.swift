import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

private struct AuthenticatedAvatarImageCacheEnvironmentKey: EnvironmentKey {
    static let defaultValue: AuthenticatedAvatarImageCache? = nil
}

extension EnvironmentValues {
    var authenticatedAvatarImageCache: AuthenticatedAvatarImageCache? {
        get { self[AuthenticatedAvatarImageCacheEnvironmentKey.self] }
        set { self[AuthenticatedAvatarImageCacheEnvironmentKey.self] = newValue }
    }
}

struct AvatarView: View {
    @Environment(\.authenticatedAvatarImageCache) private var imageCache
    @State private var imageData: Data?

    let participant: Participant
    var size: CGFloat = 44
    var showsPresence = true

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let imageData, let image = platformImage(data: imageData) {
                    image
                        .resizable()
                        .scaledToFill()
                } else {
                    Circle()
                        .fill(
                    LinearGradient(
                        colors: [Color(hexString: participant.accentHex), LuxoraTheme.deepViolet],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay {
                    ZStack {
                        Capsule()
                            .fill(.black.opacity(0.52))
                            .frame(width: size * 0.58, height: size * 0.46)
                        Canvas { context, canvasSize in
                            let initials = context.resolve(
                                Text(participant.initials)
                                    .font(
                                        .system(
                                            size: size * 0.32,
                                            weight: .semibold,
                                            design: .rounded
                                        )
                                    )
                                    .foregroundStyle(.white)
                            )
                            context.draw(
                                initials,
                                at: CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)
                            )
                        }
                    }
                    .accessibilityHidden(true)
                }
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())

            if showsPresence, participant.isOnline {
                Circle()
                    .fill(LuxoraTheme.success)
                    .frame(width: max(9, size * 0.24), height: max(9, size * 0.24))
                    .overlay(Circle().stroke(.background, lineWidth: 2))
                    .accessibilityLabel(LuxoraL10n.text("common.online"))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(participant.displayName)
        .accessibilityValue(
            showsPresence && participant.isOnline ? LuxoraL10n.text("common.online") : ""
        )
        .task(id: participant.avatarPath) {
            imageData = nil
            guard let path = participant.avatarPath, let imageCache else { return }
            do {
                imageData = try await imageCache.data(for: path)
            } catch is CancellationError {
                return
            } catch {
                // Initials remain the truthful, deterministic fallback. A
                // retry occurs when this view is recreated or the path changes.
                imageData = nil
            }
        }
    }

    private func platformImage(data: Data) -> Image? {
        #if os(iOS)
        guard let image = UIImage(data: data) else { return nil }
        return Image(uiImage: image)
        #elseif os(macOS)
        guard let image = NSImage(data: data) else { return nil }
        return Image(nsImage: image)
        #else
        return nil
        #endif
    }
}

private extension Color {
    init(hexString: String) {
        let value = UInt(hexString, radix: 16) ?? 0x7657FF
        self.init(hex: value)
    }
}
