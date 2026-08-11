import Foundation
@testable import LuxoraKit
import XCTest

final class AuthenticatedAvatarImageCacheTests: XCTestCase {
    func testConcurrentRequestsCoalesceAndLaterReadUsesMemoryCache() async throws {
        let cache = AuthenticatedAvatarImageCache()
        let probe = AvatarImageLoaderProbe(data: Data([1, 2, 3, 4]))
        let path = Self.avatarPath
        await cache.configure(namespace: Self.firstNamespace) { path in
            try await probe.load(path)
        }

        async let first = cache.data(for: path)
        async let second = cache.data(for: path)
        let values = try await [first, second]

        XCTAssertEqual(values, [Data([1, 2, 3, 4]), Data([1, 2, 3, 4])])
        let cachedValue = try await cache.data(for: path)
        let callCount = await probe.callCount
        XCTAssertEqual(cachedValue, Data([1, 2, 3, 4]))
        XCTAssertEqual(callCount, 1)
    }

    func testReconfigurationCancelsOldGenerationAndDoesNotPublishLateBytes() async throws {
        let cache = AuthenticatedAvatarImageCache()
        let suspended = SuspendedAvatarImageLoader()
        let path = Self.avatarPath
        await cache.configure(namespace: Self.firstNamespace) { path in
            try await suspended.load(path)
        }

        let oldRead = Task { try await cache.data(for: path) }
        await suspended.waitUntilStarted()
        await cache.configure(namespace: Self.secondNamespace) { _ in Data([9, 9]) }
        await suspended.release(Data([1, 1]))

        do {
            _ = try await oldRead.value
            XCTFail("A prior credential generation must not publish image bytes")
        } catch {
            // Expected cancellation fence.
        }
        let newValue = try await cache.data(for: path)
        XCTAssertEqual(newValue, Data([9, 9]))
    }

    func testSamePathCannotCrossAuthenticatedSessionOrAPIOriginNamespace() async throws {
        let cache = AuthenticatedAvatarImageCache()
        let path = Self.avatarPath
        await cache.configure(namespace: Self.firstNamespace) { _ in Data([1]) }
        let firstValue = try await cache.data(for: path)
        XCTAssertEqual(firstValue, Data([1]))

        await cache.configure(namespace: Self.secondNamespace) { _ in Data([2]) }

        let secondValue = try await cache.data(for: path)
        XCTAssertEqual(secondValue, Data([2]))
    }

    func testClearDropsCredentialsAndCachedBytes() async throws {
        let cache = AuthenticatedAvatarImageCache()
        let path = Self.avatarPath
        await cache.configure(namespace: Self.firstNamespace) { _ in Data([7]) }
        let value = try await cache.data(for: path)
        XCTAssertEqual(value, Data([7]))

        await cache.clear()

        do {
            _ = try await cache.data(for: path)
            XCTFail("Signed-out cache must not serve prior-account bytes")
        } catch {
            // Expected: loader and cache are both cleared.
        }
    }

    private static let firstNamespace = "https://api.one.example|session-a"
    private static let secondNamespace = "https://api.two.example|session-b"

    private static var avatarPath: String {
        "/v1/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content"
    }
}

private actor AvatarImageLoaderProbe {
    let data: Data
    private(set) var callCount = 0

    init(data: Data) {
        self.data = data
    }

    func load(_ path: String) async throws -> Data {
        callCount += 1
        try await Task.sleep(for: .milliseconds(20))
        return data
    }
}

private actor SuspendedAvatarImageLoader {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var resultWaiters: [CheckedContinuation<Data, Error>] = []

    func load(_ path: String) async throws -> Data {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        return try await withCheckedThrowingContinuation { resultWaiters.append($0) }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release(_ data: Data) {
        resultWaiters.forEach { $0.resume(returning: data) }
        resultWaiters.removeAll()
    }
}
