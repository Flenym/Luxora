import SwiftUI

struct AvatarView: View {
    let participant: Participant
    var size: CGFloat = 44
    var showsPresence = true

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [Color(hexString: participant.accentHex), LuxoraTheme.deepViolet],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay {
                    Text(participant.initials)
                        .font(.system(size: size * 0.32, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                }
                .frame(width: size, height: size)

            if showsPresence, participant.isOnline {
                Circle()
                    .fill(LuxoraTheme.success)
                    .frame(width: max(9, size * 0.24), height: max(9, size * 0.24))
                    .overlay(Circle().stroke(.background, lineWidth: 2))
                    .accessibilityLabel(LuxoraL10n.text("common.online"))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(participant.displayName)
    }
}

private extension Color {
    init(hexString: String) {
        let value = UInt(hexString, radix: 16) ?? 0x7657FF
        self.init(hex: value)
    }
}
