import SwiftUI

struct GlassSurface<Content: View>: View {
    let cornerRadius: CGFloat
    let interactive: Bool
    @ViewBuilder let content: Content

    init(
        cornerRadius: CGFloat = 24,
        interactive: Bool = false,
        @ViewBuilder content: () -> Content
    ) {
        self.cornerRadius = cornerRadius
        self.interactive = interactive
        self.content = content()
    }

    var body: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            if interactive {
                content
                    .glassEffect(
                        .regular.tint(LuxoraTheme.violet.opacity(0.08)).interactive(),
                        in: .rect(cornerRadius: cornerRadius)
                    )
            } else {
                content
                    .glassEffect(
                        .regular.tint(LuxoraTheme.violet.opacity(0.06)),
                        in: .rect(cornerRadius: cornerRadius)
                    )
            }
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .stroke(.white.opacity(0.12), lineWidth: 0.7)
                }
        }
    }
}
