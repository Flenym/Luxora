import SwiftUI

public enum LuxoraTheme {
    public static let ink = Color(hex: 0x090914)
    public static let deepViolet = Color(hex: 0x2F1893)
    public static let violet = Color(hex: 0x7C48D4)
    public static let electricBlue = Color(hex: 0x373ABF)
    public static let iris = Color(hex: 0xA999ED)
    public static let frost = Color(hex: 0xC0C2F7)
    public static let accent = Color(hex: 0x7657FF)
    public static let success = Color(hex: 0x4CD7A4)

    public static let brandGradient = LinearGradient(
        colors: [electricBlue, deepViolet, violet, iris],
        startPoint: .bottomLeading,
        endPoint: .topTrailing
    )

    public static let ambientGradient = RadialGradient(
        colors: [violet.opacity(0.22), electricBlue.opacity(0.08), .clear],
        center: .topTrailing,
        startRadius: 10,
        endRadius: 620
    )
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255,
            opacity: alpha
        )
    }
}
