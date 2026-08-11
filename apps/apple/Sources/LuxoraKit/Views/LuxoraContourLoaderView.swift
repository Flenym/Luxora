import SwiftUI

/// The production-native Luxora loading treatment.
///
/// The reviewed route is geometry only. This view deliberately never strokes
/// that route and never renders the source logo; it paints exactly two short
/// trails whose heads remain half a route apart.
public struct LuxoraContourLoaderView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.scenePhase) private var scenePhase

    @State private var clock = LuxoraContourLoaderClock()

    private let size: CGFloat
    private let accessibilityLabel: String

    public init(
        size: CGFloat = 88,
        accessibilityLabel: String = "Загрузка Luxora"
    ) {
        self.size = max(44, size)
        self.accessibilityLabel = accessibilityLabel
    }

    public var body: some View {
        TimelineView(
            .animation(
                minimumInterval: 1.0 / 60.0,
                paused: reduceMotion || scenePhase != .active
            )
        ) { _ in
            let phase = LuxoraContourLoaderMotion.phase(
                elapsed: clock.elapsed(at: ProcessInfo.processInfo.systemUptime),
                reduceMotion: reduceMotion
            )

            Canvas(opaque: false, rendersAsynchronously: true) { context, canvasSize in
                let routeRect = CGRect(origin: .zero, size: canvasSize).insetBy(
                    dx: 5,
                    dy: 5
                )

                for (runnerIndex, offset) in LuxoraContourLoaderMotion.runnerOffsets.enumerated() {
                    drawRunner(
                        index: runnerIndex,
                        routeRect: routeRect,
                        phase: phase + offset,
                        in: &context
                    )
                }
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue("В процессе")
        .accessibilityIdentifier("luxora-contour-loader")
        .onAppear {
            clock.setActive(scenePhase == .active, at: ProcessInfo.processInfo.systemUptime)
        }
        .onChange(of: scenePhase) { _, newPhase in
            clock.setActive(newPhase == .active, at: ProcessInfo.processInfo.systemUptime)
        }
    }

    private func drawRunner(
        index: Int,
        routeRect: CGRect,
        phase: Double,
        in context: inout GraphicsContext
    ) {
        let trailColor = runnerColor(at: index)

        for (sampleIndex, sampleAge) in LuxoraContourLoaderMotion.trailSampleAges.enumerated() {
            let samplePhase = LuxoraContourLoaderMotion.wrap(
                phase - LuxoraContourLoaderMotion.trailFraction * sampleAge
            )
            let point = LuxoraContourLoaderRoute.cachedPoint(
                in: routeRect,
                at: samplePhase
            )

            let progress = Double(sampleIndex + 1)
                / Double(LuxoraContourLoaderMotion.trailSampleCount)
            let strength = pow(progress, 1.65)
            let radius = 0.72 + 2.05 * strength
            let particle = CGRect(
                x: point.x - radius,
                y: point.y - radius,
                width: radius * 2,
                height: radius * 2
            )

            if shouldDrawGlow {
                let glowRadius = radius + 2.35 * strength
                let glow = CGRect(
                    x: point.x - glowRadius,
                    y: point.y - glowRadius,
                    width: glowRadius * 2,
                    height: glowRadius * 2
                )
                context.fill(
                    Path(ellipseIn: glow),
                    with: .color(trailColor.opacity(0.015 + 0.09 * strength))
                )
            }

            context.fill(
                Path(ellipseIn: particle),
                with: .color(
                    trailColor.opacity(
                        reduceTransparency ? 1 : 0.04 + 0.82 * strength
                    )
                )
            )
        }

        let head = LuxoraContourLoaderRoute.cachedPoint(in: routeRect, at: phase)
        let diameter: CGFloat = size <= 96 ? 6 : 8
        context.fill(
            Path(
                ellipseIn: CGRect(
                    x: head.x - diameter / 2,
                    y: head.y - diameter / 2,
                    width: diameter,
                    height: diameter
                )
            ),
            with: .color(headColor)
        )
    }

    private var shouldDrawGlow: Bool {
        colorScheme == .dark && !reduceTransparency && contrast == .standard
    }

    private var headColor: Color {
        colorScheme == .dark ? .white : .black
    }

    private func runnerColor(at index: Int) -> Color {
        guard colorScheme == .dark,
              contrast == .standard,
              !reduceTransparency
        else {
            return headColor
        }
        return index.isMultiple(of: 2) ? LuxoraTheme.violet : LuxoraTheme.frost
    }
}

enum LuxoraContourLoaderMotion {
    static let revolutionDuration: TimeInterval = 1.8
    static let runnerOffsets = [0.0, 0.5]
    static let trailSampleCount = 14
    static let trailFraction = 0.09
    static let reducedMotionPhase = 0.18
    static let trailSampleAges: [Double] = (0..<trailSampleCount).map { sampleIndex in
        Double(trailSampleCount - 1 - sampleIndex) / Double(trailSampleCount - 1)
    }

    static func phase(elapsed: TimeInterval, reduceMotion: Bool) -> Double {
        guard !reduceMotion else { return reducedMotionPhase }
        let positiveElapsed = max(0, elapsed)
        return positiveElapsed.truncatingRemainder(dividingBy: revolutionDuration)
            / revolutionDuration
    }

    static func trailSamplePhases(headPhase: Double) -> [Double] {
        trailSampleAges.map { age in
            wrap(headPhase - trailFraction * age)
        }
    }

    static func wrap(_ phase: Double) -> Double {
        phase - floor(phase)
    }
}

struct LuxoraContourLoaderClock: Equatable {
    private var origin: TimeInterval
    private var pausedAt: TimeInterval?
    private var accumulatedPause: TimeInterval = 0

    init(startUptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        origin = startUptime
    }

    mutating func setActive(_ isActive: Bool, at uptime: TimeInterval) {
        if isActive {
            guard let pausedAt else { return }
            accumulatedPause += max(0, uptime - pausedAt)
            self.pausedAt = nil
        } else if pausedAt == nil {
            pausedAt = uptime
        }
    }

    func elapsed(at uptime: TimeInterval) -> TimeInterval {
        let effectiveNow = pausedAt ?? uptime
        return max(0, effectiveNow - origin - accumulatedPause)
    }
}

enum LuxoraContourLoaderRoute {
    static let reviewedAssetSHA256 = "a31ee4352a86f16e8dca7a052abd4cd29e90ec2ad3577efc6c2a5a12488b415d"
    static let sourceViewBox = CGRect(x: 0, y: 0, width: 1_254, height: 1_254)
    static let sourceBounds = CGRect(x: 350, y: 264, width: 620, height: 676)
    static let start = CGPoint(x: 584, y: 264)

    struct CubicSegment: Equatable {
        let end: CGPoint
        let control1: CGPoint
        let control2: CGPoint
    }

    static let segments: [CubicSegment] = [
        .init(
            end: CGPoint(x: 375, y: 775),
            control1: CGPoint(x: 535, y: 292),
            control2: CGPoint(x: 420, y: 592)
        ),
        .init(
            end: CGPoint(x: 439, y: 940),
            control1: CGPoint(x: 350, y: 875),
            control2: CGPoint(x: 390, y: 932)
        ),
        .init(
            end: CGPoint(x: 537, y: 799),
            control1: CGPoint(x: 454, y: 890),
            control2: CGPoint(x: 493, y: 825)
        ),
        .init(
            end: CGPoint(x: 947, y: 768),
            control1: CGPoint(x: 646, y: 748),
            control2: CGPoint(x: 866, y: 724)
        ),
        .init(
            end: CGPoint(x: 809, y: 874),
            control1: CGPoint(x: 970, y: 788),
            control2: CGPoint(x: 866, y: 858)
        ),
        .init(
            end: CGPoint(x: 537, y: 799),
            control1: CGPoint(x: 704, y: 892),
            control2: CGPoint(x: 607, y: 835)
        ),
        .init(
            end: CGPoint(x: 525, y: 611),
            control1: CGPoint(x: 493, y: 760),
            control2: CGPoint(x: 514, y: 682)
        ),
        .init(
            end: CGPoint(x: 584, y: 264),
            control1: CGPoint(x: 539, y: 501),
            control2: CGPoint(x: 571, y: 327)
        ),
    ]

    /// A route-wide, arc-length lookup generated once from the reviewed cubic
    /// geometry. Per-frame work only interpolates two short 14-point trails;
    /// it does not rebuild/trim a SwiftUI path for every particle.
    static let cachedPointCount = 320
    static let cachedSourcePoints: [CGPoint] = makeArcLengthCache()

    static func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / sourceBounds.width, rect.height / sourceBounds.height)

        func transformed(_ source: CGPoint) -> CGPoint {
            CGPoint(
                x: rect.midX + (source.x - sourceBounds.midX) * scale,
                y: rect.midY + (source.y - sourceBounds.midY) * scale
            )
        }

        var path = Path()
        path.move(to: transformed(start))
        for segment in segments {
            path.addCurve(
                to: transformed(segment.end),
                control1: transformed(segment.control1),
                control2: transformed(segment.control2)
            )
        }
        path.closeSubpath()
        return path
    }

    static func point(on route: Path, at rawPhase: Double) -> CGPoint? {
        let wrapped = LuxoraContourLoaderMotion.wrap(rawPhase)
        let end = min(1, max(0.000_01, wrapped))
        return route.trimmedPath(from: 0, to: end).currentPoint
    }

    static func cachedPoint(in rect: CGRect, at rawPhase: Double) -> CGPoint {
        let phase = LuxoraContourLoaderMotion.wrap(rawPhase)
        let scaledIndex = phase * Double(cachedSourcePoints.count)
        let lowerIndex = Int(floor(scaledIndex)) % cachedSourcePoints.count
        let upperIndex = (lowerIndex + 1) % cachedSourcePoints.count
        let fraction = CGFloat(scaledIndex - floor(scaledIndex))
        let lower = cachedSourcePoints[lowerIndex]
        let upper = cachedSourcePoints[upperIndex]
        let source = CGPoint(
            x: lower.x + (upper.x - lower.x) * fraction,
            y: lower.y + (upper.y - lower.y) * fraction
        )
        let scale = min(rect.width / sourceBounds.width, rect.height / sourceBounds.height)

        return CGPoint(
            x: rect.midX + (source.x - sourceBounds.midX) * scale,
            y: rect.midY + (source.y - sourceBounds.midY) * scale
        )
    }

    private static func makeArcLengthCache() -> [CGPoint] {
        let subdivisionsPerSegment = 96
        var densePoints = [start]
        var segmentStart = start

        for segment in segments {
            for subdivision in 1...subdivisionsPerSegment {
                let t = CGFloat(subdivision) / CGFloat(subdivisionsPerSegment)
                densePoints.append(
                    cubicPoint(
                        from: segmentStart,
                        control1: segment.control1,
                        control2: segment.control2,
                        to: segment.end,
                        t: t
                    )
                )
            }
            segmentStart = segment.end
        }

        var cumulativeLengths = [CGFloat](repeating: 0, count: densePoints.count)
        for index in 1..<densePoints.count {
            cumulativeLengths[index] = cumulativeLengths[index - 1]
                + distance(from: densePoints[index - 1], to: densePoints[index])
        }

        guard let totalLength = cumulativeLengths.last, totalLength > 0 else {
            return [start]
        }

        var result: [CGPoint] = []
        result.reserveCapacity(cachedPointCount)
        var denseIndex = 1

        for sampleIndex in 0..<cachedPointCount {
            let target = totalLength * CGFloat(sampleIndex) / CGFloat(cachedPointCount)
            while denseIndex < cumulativeLengths.count - 1,
                  cumulativeLengths[denseIndex] < target
            {
                denseIndex += 1
            }

            let previousIndex = max(0, denseIndex - 1)
            let lowerLength = cumulativeLengths[previousIndex]
            let upperLength = cumulativeLengths[denseIndex]
            let interval = max(upperLength - lowerLength, .leastNonzeroMagnitude)
            let fraction = (target - lowerLength) / interval
            let lower = densePoints[previousIndex]
            let upper = densePoints[denseIndex]
            result.append(
                CGPoint(
                    x: lower.x + (upper.x - lower.x) * fraction,
                    y: lower.y + (upper.y - lower.y) * fraction
                )
            )
        }

        return result
    }

    private static func cubicPoint(
        from start: CGPoint,
        control1: CGPoint,
        control2: CGPoint,
        to end: CGPoint,
        t: CGFloat
    ) -> CGPoint {
        let inverse = 1 - t
        let startWeight = inverse * inverse * inverse
        let firstWeight = 3 * inverse * inverse * t
        let secondWeight = 3 * inverse * t * t
        let endWeight = t * t * t

        return CGPoint(
            x: startWeight * start.x
                + firstWeight * control1.x
                + secondWeight * control2.x
                + endWeight * end.x,
            y: startWeight * start.y
                + firstWeight * control1.y
                + secondWeight * control2.y
                + endWeight * end.y
        )
    }

    private static func distance(from first: CGPoint, to second: CGPoint) -> CGFloat {
        hypot(second.x - first.x, second.y - first.y)
    }
}

#Preview("Contour loader — dark") {
    LuxoraContourLoaderView(size: 96)
        .padding(48)
        .background(Color.black)
        .preferredColorScheme(.dark)
}

#Preview("Contour loader — light") {
    LuxoraContourLoaderView(size: 96)
        .padding(48)
        .background(Color.white)
        .preferredColorScheme(.light)
}
