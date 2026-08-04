import SwiftUI

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

public struct LuxoraLogoView: View {
    private let size: CGFloat

    public init(size: CGFloat = 42) {
        self.size = size
    }

    public var body: some View {
        Group {
            #if canImport(AppKit)
            if let image = bundledAppKitImage {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                fallbackMark
            }
            #elseif canImport(UIKit)
            if let image = bundledUIKitImage {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                fallbackMark
            }
            #else
            fallbackMark
            #endif
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        .accessibilityLabel("Luxora")
    }

    #if canImport(AppKit)
    private var bundledAppKitImage: NSImage? {
        if let url = Bundle.main.url(forResource: "logo", withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            return image
        }
        return NSImage(named: "logo")
    }
    #elseif canImport(UIKit)
    private var bundledUIKitImage: UIImage? {
        if let url = Bundle.main.url(forResource: "logo", withExtension: "png"),
           let image = UIImage(contentsOfFile: url.path) {
            return image
        }
        return UIImage(named: "logo")
    }
    #endif

    private var fallbackMark: some View {
        ZStack {
            LuxoraTheme.ink
            Image(systemName: "sparkle")
                .font(.system(size: size * 0.46, weight: .medium))
                .foregroundStyle(LuxoraTheme.brandGradient)
        }
    }
}
