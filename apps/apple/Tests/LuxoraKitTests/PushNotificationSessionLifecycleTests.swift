import Foundation
@testable import LuxoraKit
import XCTest

@MainActor
final class PushNotificationSessionLifecycleTests: XCTestCase {
    func testTokenBeforeSessionRegistersOnlyAfterAuthenticatedStoreAttaches() async {
        let lifecycle = PushNotificationSessionLifecycle()
        let probe = LifecyclePushProbe(registration: Self.registration())
        let store = Self.store(probe: probe)
        let token = Self.token(byte: 0x12)

        await lifecycle.receive(deviceToken: token, environment: .development)
        let beforeAttach = await probe.snapshot
        XCTAssertEqual(beforeAttach.registerCount, 0)

        lifecycle.attach(store)
        await lifecycle.synchronizeAttachedStore()

        let snapshot = await probe.snapshot
        XCTAssertEqual(snapshot.loadCount, 0)
        XCTAssertEqual(snapshot.registerCount, 1)
        XCTAssertEqual(snapshot.lastToken, Self.hex(token))
        XCTAssertEqual(snapshot.lastEnvironment, .development)
        XCTAssertEqual(store.registration, Self.registration())
    }

    func testSessionBeforeTokenLoadsThenRegistersWhenIOSDeliversToken() async {
        let lifecycle = PushNotificationSessionLifecycle()
        let probe = LifecyclePushProbe(registration: Self.registration(environment: .production))
        let store = Self.store(probe: probe)
        let token = Self.token(byte: 0x34)

        lifecycle.attach(store)
        await lifecycle.synchronizeAttachedStore()
        var snapshot = await probe.snapshot
        XCTAssertEqual(snapshot.loadCount, 1)
        XCTAssertEqual(snapshot.registerCount, 0)

        await lifecycle.receive(deviceToken: token, environment: .production)
        snapshot = await probe.snapshot
        XCTAssertEqual(snapshot.loadCount, 1)
        XCTAssertEqual(snapshot.registerCount, 1)
        XCTAssertEqual(snapshot.lastToken, Self.hex(token))
        XCTAssertEqual(snapshot.lastEnvironment, .production)
    }

    func testReplacingSessionFencesLateOldRegistrationAndBindsTokenToNewStore() async {
        let lifecycle = PushNotificationSessionLifecycle()
        let lateRegistration = Self.registration(id: "11111111-1111-4111-8111-111111111111")
        let oldProbe = SuspendedLifecycleRegistration(result: .success(lateRegistration))
        let oldStore = Self.suspendedStore(probe: oldProbe)
        lifecycle.attach(oldStore)

        let token = Self.token(byte: 0x56)
        let oldRequest = Task {
            await lifecycle.receive(deviceToken: token, environment: .development)
        }
        await oldProbe.waitUntilStarted()

        let newRegistration = Self.registration(id: "22222222-2222-4222-8222-222222222222")
        let newProbe = LifecyclePushProbe(registration: newRegistration)
        let newStore = Self.store(probe: newProbe)
        lifecycle.attach(newStore)
        await lifecycle.synchronizeAttachedStore()
        await oldProbe.release()
        await oldRequest.value

        XCTAssertNil(oldStore.registration)
        XCTAssertEqual(oldStore.state, .idle)
        XCTAssertEqual(newStore.registration, newRegistration)
        let newSnapshot = await newProbe.snapshot
        XCTAssertEqual(newSnapshot.registerCount, 1)
        XCTAssertEqual(newSnapshot.lastToken, Self.hex(token))
    }

    func testSignOutDetachFencesLateResponseAndRetainsOnlyProcessTokenForNextSession() async {
        let lifecycle = PushNotificationSessionLifecycle()
        let oldProbe = SuspendedLifecycleRegistration(result: .success(Self.registration()))
        let oldStore = Self.suspendedStore(probe: oldProbe)
        lifecycle.attach(oldStore)

        let token = Self.token(byte: 0x78)
        let request = Task {
            await lifecycle.receive(deviceToken: token, environment: .development)
        }
        await oldProbe.waitUntilStarted()
        lifecycle.detach()
        await oldProbe.release()
        await request.value

        XCTAssertNil(oldStore.registration)
        XCTAssertEqual(oldStore.state, .idle)

        let nextProbe = LifecyclePushProbe(registration: Self.registration(
            id: "33333333-3333-4333-8333-333333333333"
        ))
        let nextStore = Self.store(probe: nextProbe)
        lifecycle.attach(nextStore)
        await lifecycle.synchronizeAttachedStore()

        let nextSnapshot = await nextProbe.snapshot
        XCTAssertEqual(nextSnapshot.registerCount, 1)
        XCTAssertEqual(nextSnapshot.lastToken, Self.hex(token))
    }

    func testDetachSuppressesLateUnauthorizedFailureFromExpiredSession() async {
        let lifecycle = PushNotificationSessionLifecycle()
        let unauthorized = LuxoraAPIError.server(
            status: 401,
            code: "UNAUTHORIZED",
            message: "expired"
        )
        let probe = SuspendedLifecycleRegistration(result: .failure(unauthorized))
        let store = Self.suspendedStore(probe: probe)
        lifecycle.attach(store)

        let request = Task {
            await lifecycle.receive(deviceToken: Self.token(byte: 0x9a), environment: .development)
        }
        await probe.waitUntilStarted()
        lifecycle.detach()
        await probe.release()
        await request.value

        XCTAssertNil(store.registration)
        XCTAssertEqual(store.state, .idle)
    }

    func testDeniedAuthorizationClearsPendingTokenAndRevokesAttachedRegistration() async {
        let lifecycle = PushNotificationSessionLifecycle()
        let probe = LifecyclePushProbe(registration: Self.registration())
        let store = Self.store(probe: probe)
        lifecycle.attach(store)
        await lifecycle.receive(deviceToken: Self.token(byte: 0xbc), environment: .development)

        await lifecycle.synchronizeAuthorization(isAuthorized: false)
        XCTAssertNil(store.registration)
        var snapshot = await probe.snapshot
        XCTAssertEqual(snapshot.unregisterCount, 1)

        lifecycle.detach()
        let nextProbe = LifecyclePushProbe(registration: Self.registration())
        let nextStore = Self.store(probe: nextProbe)
        lifecycle.attach(nextStore)
        await lifecycle.synchronizeAttachedStore()
        snapshot = await nextProbe.snapshot
        XCTAssertEqual(snapshot.registerCount, 0)
        XCTAssertEqual(snapshot.unregisterCount, 1)
    }

    func testMalformedTokenIsNeverRetainedForAReplacementSession() async {
        let lifecycle = PushNotificationSessionLifecycle()
        await lifecycle.receive(deviceToken: Data([0x01, 0x02]), environment: .development)

        let probe = LifecyclePushProbe(registration: Self.registration())
        let store = Self.store(probe: probe)
        lifecycle.attach(store)
        await lifecycle.synchronizeAttachedStore()

        let snapshot = await probe.snapshot
        XCTAssertEqual(snapshot.loadCount, 1)
        XCTAssertEqual(snapshot.registerCount, 0)
        XCTAssertNil(snapshot.lastToken)
    }

    func testRotatedTokenFencesLateRegistrationForPreviousAppleToken() async {
        let lifecycle = PushNotificationSessionLifecycle()
        let firstRegistration = Self.registration(
            id: "44444444-4444-4444-8444-444444444444"
        )
        let latestRegistration = Self.registration(
            id: "55555555-5555-4555-8555-555555555555"
        )
        let probe = RotatingLifecycleRegistration(
            first: firstRegistration,
            latest: latestRegistration
        )
        let store = PushRegistrationStore()
        store.configureRemote(
            loader: { nil },
            registrar: { token, environment in
                await probe.register(token: token, environment: environment)
            },
            unregistrar: {}
        )
        lifecycle.attach(store)

        let firstToken = Self.token(byte: 0xc1)
        let latestToken = Self.token(byte: 0xc2)
        let firstRequest = Task {
            await lifecycle.receive(deviceToken: firstToken, environment: .development)
        }
        await probe.waitUntilFirstStarted()
        await lifecycle.receive(deviceToken: latestToken, environment: .development)
        await probe.releaseFirst()
        await firstRequest.value

        XCTAssertEqual(store.registration, latestRegistration)
        let tokens = await probe.tokens
        XCTAssertEqual(tokens, [Self.hex(firstToken), Self.hex(latestToken)])
    }

    func testBuildEnvironmentEntitlementAndLoggingContractsStayAligned() throws {
        XCTAssertEqual(APNSPushEnvironment.environment(forDebugBuild: true), .development)
        XCTAssertEqual(APNSPushEnvironment.environment(forDebugBuild: false), .production)
        #if DEBUG
        XCTAssertEqual(APNSPushEnvironment.currentApplicationBuild, .development)
        #else
        XCTAssertEqual(APNSPushEnvironment.currentApplicationBuild, .production)
        #endif

        let appleRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let projectYAML = try String(
            contentsOf: appleRoot.appendingPathComponent("project.yml"),
            encoding: .utf8
        )
        XCTAssertTrue(projectYAML.contains("Debug:\n          APS_ENVIRONMENT: development"))
        XCTAssertTrue(projectYAML.contains("Release:\n          APS_ENVIRONMENT: production"))
        XCTAssertTrue(projectYAML.contains(
            "CODE_SIGN_ENTITLEMENTS: Apps/iOS/LuxoraMobile.entitlements"
        ))

        let entitlements = try String(
            contentsOf: appleRoot.appendingPathComponent("Apps/iOS/LuxoraMobile.entitlements"),
            encoding: .utf8
        )
        XCTAssertTrue(entitlements.contains("<key>aps-environment</key>"))
        XCTAssertTrue(entitlements.contains("<string>$(APS_ENVIRONMENT)</string>"))

        let project = try String(
            contentsOf: appleRoot.appendingPathComponent("Luxora.xcodeproj/project.pbxproj"),
            encoding: .utf8
        )
        XCTAssertEqual(project.occurrences(of: "APS_ENVIRONMENT = development;"), 1)
        XCTAssertEqual(project.occurrences(of: "APS_ENVIRONMENT = production;"), 1)

        let bridge = try String(
            contentsOf: appleRoot.appendingPathComponent("Apps/iOS/LuxoraMobileApp.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(bridge.contains(".currentApplicationBuild"))

        let noLogSources = [
            bridge,
            try String(
                contentsOf: appleRoot.appendingPathComponent(
                    "Sources/LuxoraKit/Stores/PushNotificationSessionLifecycle.swift"
                ),
                encoding: .utf8
            ),
            try String(
                contentsOf: appleRoot.appendingPathComponent(
                    "Sources/LuxoraKit/Stores/NotificationSettingsStore.swift"
                ),
                encoding: .utf8
            ),
            try String(
                contentsOf: appleRoot.appendingPathComponent(
                    "Sources/LuxoraKit/Stores/ApplicationSession.swift"
                ),
                encoding: .utf8
            ),
            try String(
                contentsOf: appleRoot.appendingPathComponent(
                    "Sources/LuxoraKit/Services/LuxoraAPIClient.swift"
                ),
                encoding: .utf8
            ),
        ]
        let loggingCallPattern = try NSRegularExpression(
            pattern: #"\b(?:print|debugPrint|dump|NSLog|os_log|Logger)\s*\("#
        )
        for source in noLogSources {
            let sourceRange = NSRange(source.startIndex..., in: source)
            XCTAssertNil(
                loggingCallPattern.firstMatch(in: source, range: sourceRange),
                "APNs boundary must not contain logging calls"
            )
        }

        let projection = Self.registration()
        let publicLabels = Set(Mirror(reflecting: projection).children.compactMap(\.label))
        XCTAssertEqual(publicLabels, ["id", "environment", "topic", "createdAt", "updatedAt"])
        XCTAssertFalse(String(describing: projection).contains(Self.hex(Self.token(byte: 0xde))))
    }

    private static func store(probe: LifecyclePushProbe) -> PushRegistrationStore {
        let store = PushRegistrationStore()
        store.configureRemote(
            loader: { await probe.load() },
            registrar: { token, environment in
                await probe.register(token: token, environment: environment)
            },
            unregistrar: { await probe.unregister() }
        )
        return store
    }

    private static func suspendedStore(
        probe: SuspendedLifecycleRegistration
    ) -> PushRegistrationStore {
        let store = PushRegistrationStore()
        store.configureRemote(
            loader: { nil },
            registrar: { token, environment in
                try await probe.register(token: token, environment: environment)
            },
            unregistrar: {}
        )
        return store
    }

    private nonisolated static func token(byte: UInt8) -> Data {
        Data(repeating: byte, count: 32)
    }

    private nonisolated static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    private nonisolated static func registration(
        id: String = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        environment: APNSPushEnvironment = .development
    ) -> PushRegistration {
        PushRegistration(response: APIPushRegistration(
            id: UUID(uuidString: id)!,
            platform: "apns",
            environment: environment,
            topic: "app.luxora.mobile",
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 2)
        ))
    }
}

private actor LifecyclePushProbe {
    struct Snapshot: Sendable {
        let loadCount: Int
        let registerCount: Int
        let unregisterCount: Int
        let lastToken: String?
        let lastEnvironment: APNSPushEnvironment?
    }

    private let registration: PushRegistration
    private var loadCount = 0
    private var registerCount = 0
    private var unregisterCount = 0
    private var lastToken: String?
    private var lastEnvironment: APNSPushEnvironment?

    init(registration: PushRegistration) {
        self.registration = registration
    }

    func load() -> PushRegistration? {
        loadCount += 1
        return nil
    }

    func register(token: String, environment: APNSPushEnvironment) -> PushRegistration {
        registerCount += 1
        lastToken = token
        lastEnvironment = environment
        return registration
    }

    func unregister() {
        unregisterCount += 1
    }

    var snapshot: Snapshot {
        Snapshot(
            loadCount: loadCount,
            registerCount: registerCount,
            unregisterCount: unregisterCount,
            lastToken: lastToken,
            lastEnvironment: lastEnvironment
        )
    }
}

private actor SuspendedLifecycleRegistration {
    private let result: Result<PushRegistration, Error>
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(result: Result<PushRegistration, Error>) {
        self.result = result
    }

    func register(token: String, environment: APNSPushEnvironment) async throws -> PushRegistration {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseWaiters.append($0) }
        return try result.get()
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor RotatingLifecycleRegistration {
    private let first: PushRegistration
    private let latest: PushRegistration
    private var recordedTokens: [String] = []
    private var firstStarted = false
    private var firstStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstReleaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(first: PushRegistration, latest: PushRegistration) {
        self.first = first
        self.latest = latest
    }

    func register(token: String, environment: APNSPushEnvironment) async -> PushRegistration {
        recordedTokens.append(token)
        if recordedTokens.count == 1 {
            firstStarted = true
            firstStartWaiters.forEach { $0.resume() }
            firstStartWaiters.removeAll()
            await withCheckedContinuation { firstReleaseWaiters.append($0) }
            return first
        }
        return latest
    }

    func waitUntilFirstStarted() async {
        guard !firstStarted else { return }
        await withCheckedContinuation { firstStartWaiters.append($0) }
    }

    func releaseFirst() {
        firstReleaseWaiters.forEach { $0.resume() }
        firstReleaseWaiters.removeAll()
    }

    var tokens: [String] { recordedTokens }
}

private extension String {
    func occurrences(of needle: String) -> Int {
        components(separatedBy: needle).count - 1
    }
}
