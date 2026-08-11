import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class NotificationSettingsStoreTests: XCTestCase {
    func testRefreshAndPatchPublishOnlyServerReturnedSettings() async {
        let initial = Self.settings(sound: true, previewMode: .hidden)
        let updated = Self.settings(sound: false, previewMode: .sender)
        let probe = NotificationPatchProbe(result: updated)
        let store = NotificationSettingsStore()
        store.configureRemote(
            loader: { initial },
            updater: { patch in await probe.update(patch) }
        )

        await store.refresh()
        let accepted = await store.update(.init(sound: false, previewMode: .sender))

        XCTAssertTrue(accepted)
        XCTAssertEqual(store.settings, updated)
        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.mutationState, .loaded)
        let patch = await probe.patch
        XCTAssertEqual(patch?.sound, false)
        XCTAssertEqual(patch?.previewMode, .sender)
        XCTAssertNil(patch?.messageAlerts)
    }

    func testFailedPatchKeepsLastAuthoritativeSnapshotAndCanRetry() async {
        let initial = Self.settings(sound: true, previewMode: .hidden)
        let recovered = Self.settings(sound: false, previewMode: .hidden)
        let probe = NotificationFailureProbe(recovered: recovered)
        let store = NotificationSettingsStore(settings: initial)
        store.configureRemote(
            loader: { initial },
            updater: { patch in try await probe.update(patch) }
        )

        let rejected = await store.update(.init(sound: false))
        XCTAssertFalse(rejected)
        XCTAssertEqual(store.settings, initial)
        guard case let .failed(message) = store.mutationState else {
            return XCTFail("Expected a visible failure")
        }
        XCTAssertTrue(message.contains("сервером") || message.contains("Сервер"))

        let accepted = await store.update(.init(sound: false))
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.settings, recovered)
    }

    func testCancellationFencesLateSettingsResponse() async {
        let initial = Self.settings(sound: true, previewMode: .hidden)
        let late = Self.settings(sound: false, previewMode: .full)
        let probe = SuspendedNotificationUpdate()
        let store = NotificationSettingsStore(settings: initial)
        store.configureRemote(
            loader: { initial },
            updater: { _ in await probe.run() }
        )

        let task = Task { await store.update(.init(previewMode: .full)) }
        await probe.waitUntilStarted()
        store.cancelRemoteOperations()
        await probe.release(with: late)

        let accepted = await task.value
        XCTAssertFalse(accepted)
        XCTAssertEqual(store.settings, initial)
        XCTAssertEqual(store.mutationState, .idle)
    }

    func testPushStoreHexEncodesOpaqueBytesAndUnregistersWithoutExposingToken() async {
        let registration = Self.registration()
        let probe = PushRegistrationProbe(registration: registration)
        let store = PushRegistrationStore()
        store.configureRemote(
            loader: { nil },
            registrar: { token, environment in
                await probe.register(token: token, environment: environment)
            },
            unregistrar: { await probe.unregister() }
        )

        let token = Data((0..<32).map { UInt8($0) })
        let registered = await store.register(deviceToken: token, environment: .development)
        XCTAssertTrue(registered)
        XCTAssertEqual(store.registration, registration)
        let snapshot = await probe.snapshot
        XCTAssertEqual(snapshot.token, token.map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(snapshot.environment, .development)

        let unregistered = await store.unregister()
        XCTAssertTrue(unregistered)
        XCTAssertNil(store.registration)
        let finalSnapshot = await probe.snapshot
        XCTAssertEqual(finalSnapshot.unregisterCount, 1)
    }

    func testPushStoreRejectsMalformedTokenBeforeRemoteClosure() async {
        let probe = PushRegistrationProbe(registration: Self.registration())
        let store = PushRegistrationStore()
        store.configureRemote(
            loader: { nil },
            registrar: { token, environment in
                await probe.register(token: token, environment: environment)
            },
            unregistrar: { await probe.unregister() }
        )

        let accepted = await store.register(
            deviceToken: Data([1, 2, 3]),
            environment: .development
        )
        XCTAssertFalse(accepted)
        let snapshot = await probe.snapshot
        XCTAssertNil(snapshot.token)
        guard case .failed = store.state else { return XCTFail("Expected validation failure") }
    }

    private nonisolated static func settings(
        sound: Bool,
        previewMode: NotificationPreviewMode
    ) -> NotificationSettings {
        NotificationSettings(response: APINotificationSettings(
            messageAlerts: true,
            messageRequestAlerts: true,
            mentionAlerts: true,
            sound: sound,
            badge: true,
            previewMode: previewMode,
            updatedAt: Date(timeIntervalSince1970: sound ? 1 : 2)
        ))
    }

    private nonisolated static func registration() -> PushRegistration {
        PushRegistration(response: APIPushRegistration(
            id: UUID(uuidString: "B2222222-2222-4222-8222-222222222222")!,
            platform: "apns",
            environment: .development,
            topic: "app.luxora.mobile",
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 2)
        ))
    }
}

private actor NotificationPatchProbe {
    private(set) var patch: NotificationSettingsPatch?
    private let result: NotificationSettings

    init(result: NotificationSettings) { self.result = result }

    func update(_ patch: NotificationSettingsPatch) -> NotificationSettings {
        self.patch = patch
        return result
    }
}

private actor NotificationFailureProbe {
    private var shouldFail = true
    private let recovered: NotificationSettings

    init(recovered: NotificationSettings) { self.recovered = recovered }

    func update(_ patch: NotificationSettingsPatch) throws -> NotificationSettings {
        if shouldFail {
            shouldFail = false
            throw LuxoraAPIError.server(status: 503, code: "UNAVAILABLE", message: "unavailable")
        }
        return recovered
    }
}

private actor SuspendedNotificationUpdate {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var resultWaiters: [CheckedContinuation<NotificationSettings, Never>] = []

    func run() async -> NotificationSettings {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        return await withCheckedContinuation { resultWaiters.append($0) }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release(with settings: NotificationSettings) {
        resultWaiters.forEach { $0.resume(returning: settings) }
        resultWaiters.removeAll()
    }
}

private actor PushRegistrationProbe {
    struct Snapshot: Sendable {
        let token: String?
        let environment: APNSPushEnvironment?
        let unregisterCount: Int
    }

    private var token: String?
    private var environment: APNSPushEnvironment?
    private var unregisterCount = 0
    private let registration: PushRegistration

    init(registration: PushRegistration) { self.registration = registration }

    func register(token: String, environment: APNSPushEnvironment) -> PushRegistration {
        self.token = token
        self.environment = environment
        return registration
    }

    func unregister() { unregisterCount += 1 }

    var snapshot: Snapshot {
        Snapshot(token: token, environment: environment, unregisterCount: unregisterCount)
    }
}
