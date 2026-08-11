import CoreGraphics
import XCTest
@testable import LuxoraKit

final class LuxoraContourLoaderTests: XCTestCase {
    func testReviewedRouteMetadataAndCoordinatesRemainExact() {
        XCTAssertEqual(
            LuxoraContourLoaderRoute.reviewedAssetSHA256,
            "a31ee4352a86f16e8dca7a052abd4cd29e90ec2ad3577efc6c2a5a12488b415d"
        )
        XCTAssertEqual(
            LuxoraContourLoaderRoute.sourceViewBox,
            CGRect(x: 0, y: 0, width: 1_254, height: 1_254)
        )
        XCTAssertEqual(LuxoraContourLoaderRoute.start, CGPoint(x: 584, y: 264))
        XCTAssertEqual(LuxoraContourLoaderRoute.segments.count, 8)

        XCTAssertEqual(
            LuxoraContourLoaderRoute.segments,
            [
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
        )
    }

    func testTwoRunnersRemainExactlyOppositeForTheWholeRevolution() {
        XCTAssertEqual(LuxoraContourLoaderMotion.runnerOffsets, [0, 0.5])

        for elapsed in stride(from: 0.0, through: 7.2, by: 0.037) {
            let first = LuxoraContourLoaderMotion.phase(
                elapsed: elapsed,
                reduceMotion: false
            )
            let second = LuxoraContourLoaderMotion.wrap(first + 0.5)
            let separation = LuxoraContourLoaderMotion.wrap(second - first)
            XCTAssertEqual(separation, 0.5, accuracy: 0.000_000_1)
        }
    }

    func testBothRunnersAdvanceInTheSameDirectionAtTheSameSpeed() {
        let firstTime = 0.20
        let secondTime = 0.32
        let firstHead = LuxoraContourLoaderMotion.phase(
            elapsed: firstTime,
            reduceMotion: false
        )
        let secondHead = LuxoraContourLoaderMotion.phase(
            elapsed: secondTime,
            reduceMotion: false
        )
        let firstOpposite = LuxoraContourLoaderMotion.wrap(firstHead + 0.5)
        let secondOpposite = LuxoraContourLoaderMotion.wrap(secondHead + 0.5)

        XCTAssertGreaterThan(secondHead, firstHead)
        XCTAssertEqual(
            secondHead - firstHead,
            secondOpposite - firstOpposite,
            accuracy: 0.000_000_1
        )
    }

    func testTrailContainsOnlyFourteenSamplesBehindEachHead() {
        let samples = LuxoraContourLoaderMotion.trailSamplePhases(headPhase: 0.5)

        XCTAssertEqual(samples.count, 14)
        XCTAssertEqual(samples[0], 0.41, accuracy: 0.000_000_1)
        XCTAssertEqual(samples[13], 0.5, accuracy: 0.000_000_1)
        XCTAssertTrue(
            zip(samples, samples.dropFirst()).allSatisfy { earlier, later in
                earlier < later
            }
        )
    }

    func testReducedMotionUsesOneFixedOpposingPair() {
        let early = LuxoraContourLoaderMotion.phase(elapsed: 0, reduceMotion: true)
        let late = LuxoraContourLoaderMotion.phase(elapsed: 60, reduceMotion: true)

        XCTAssertEqual(early, LuxoraContourLoaderMotion.reducedMotionPhase)
        XCTAssertEqual(late, early)
        XCTAssertEqual(
            LuxoraContourLoaderMotion.wrap(early + 0.5) - early,
            0.5,
            accuracy: 0.000_000_1
        )
    }

    func testAnimationClockDoesNotAdvanceWhileTheSceneIsInactive() {
        var clock = LuxoraContourLoaderClock(startUptime: 100)
        XCTAssertEqual(clock.elapsed(at: 102), 2)

        clock.setActive(false, at: 102)
        XCTAssertEqual(clock.elapsed(at: 107), 2)

        clock.setActive(true, at: 107)
        XCTAssertEqual(clock.elapsed(at: 109), 4)
    }

    func testRouteSamplingWrapsWithoutChangingTheReviewedGeometry() throws {
        let route = LuxoraContourLoaderRoute.path(
            in: CGRect(x: 0, y: 0, width: 96, height: 96)
        )
        let first = try XCTUnwrap(LuxoraContourLoaderRoute.point(on: route, at: 0.27))
        let wrapped = try XCTUnwrap(LuxoraContourLoaderRoute.point(on: route, at: 1.27))

        XCTAssertEqual(first.x, wrapped.x, accuracy: 0.000_1)
        XCTAssertEqual(first.y, wrapped.y, accuracy: 0.000_1)
        XCTAssertLessThanOrEqual(route.boundingRect.width, 96)
        XCTAssertLessThanOrEqual(route.boundingRect.height, 96)
    }

    func testRuntimeRouteUsesOneBoundedArcLengthCache() {
        XCTAssertEqual(LuxoraContourLoaderRoute.cachedPointCount, 320)
        XCTAssertEqual(
            LuxoraContourLoaderRoute.cachedSourcePoints.count,
            LuxoraContourLoaderRoute.cachedPointCount
        )

        let rect = CGRect(x: 0, y: 0, width: 96, height: 96)
        let first = LuxoraContourLoaderRoute.cachedPoint(in: rect, at: 0.27)
        let wrapped = LuxoraContourLoaderRoute.cachedPoint(in: rect, at: 3.27)

        XCTAssertEqual(first.x, wrapped.x, accuracy: 0.000_1)
        XCTAssertEqual(first.y, wrapped.y, accuracy: 0.000_1)
        XCTAssertTrue(rect.contains(first))
    }
}
