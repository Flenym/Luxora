import XCTest
@testable import LuxoraKit

@MainActor
final class PhonePasswordSettingsStoreTests: XCTestCase {
    func testRefreshLoadsAuthoritativeEligibilityAndEnabledState() async {
        let store = PhonePasswordSettingsStore()
        store.configureRemote(
            loader: { Self.status(eligible: true, enabled: false) },
            configurator: { _, _ in Self.status(eligible: true, enabled: true) },
            disabler: { _ in Self.status(eligible: true, enabled: false) }
        )

        await store.refresh()

        XCTAssertEqual(store.status, Self.status(eligible: true, enabled: false))
        XCTAssertEqual(store.loadState, .loaded)
    }

    func testEnableChangeAndDisablePublishOnlyServerReturnedState() async {
        let probe = PhonePasswordSettingsProbe()
        let store = PhonePasswordSettingsStore(status: Self.status(eligible: true, enabled: false))
        store.configureRemote(
            loader: { Self.status(eligible: true, enabled: false) },
            configurator: { password, current in
                await probe.recordConfiguration(password: password, current: current)
                return Self.status(eligible: true, enabled: true)
            },
            disabler: { current in
                await probe.recordDisable(current: current)
                return Self.status(eligible: true, enabled: false)
            }
        )

        let enabled = await store.configure(newPassword: "first secure password", currentPassword: nil)
        let changed = await store.configure(
            newPassword: "second secure password",
            currentPassword: "first secure password"
        )
        let disabled = await store.disable(currentPassword: "second secure password")

        XCTAssertTrue(enabled)
        XCTAssertTrue(changed)
        XCTAssertTrue(disabled)

        XCTAssertEqual(store.status, Self.status(eligible: true, enabled: false))
        let snapshot = await probe.snapshot
        XCTAssertEqual(snapshot.configurations.count, 2)
        XCTAssertNil(snapshot.configurations[0].current)
        XCTAssertEqual(snapshot.configurations[1].current, "first secure password")
        XCTAssertEqual(snapshot.disabledWith, ["second secure password"])
    }

    func testInvalidCurrentPasswordHasRussianRetryStateAndCanRecover() async {
        let probe = PhonePasswordFailureProbe()
        let store = PhonePasswordSettingsStore(status: Self.status(eligible: true, enabled: true))
        store.configureRemote(
            loader: { Self.status(eligible: true, enabled: true) },
            configurator: { _, _ in
                if await probe.shouldFail() {
                    throw LuxoraAPIError.server(
                        status: 401,
                        code: "UNAUTHENTICATED",
                        message: "Invalid current password"
                    )
                }
                return Self.status(eligible: true, enabled: true)
            },
            disabler: { _ in Self.status(eligible: true, enabled: false) }
        )

        let rejected = await store.configure(newPassword: "next secure password", currentPassword: "wrong")
        XCTAssertFalse(rejected)
        XCTAssertEqual(store.mutationState, .failed("Текущий пароль неверен."))
        let accepted = await store.configure(newPassword: "next secure password", currentPassword: "correct")
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.mutationState, .loaded)
    }

    func testCancellationFencesLateNonCooperativeMutation() async {
        let probe = SuspendedPhonePasswordMutation()
        let initial = Self.status(eligible: true, enabled: false)
        let store = PhonePasswordSettingsStore(status: initial)
        store.configureRemote(
            loader: { initial },
            configurator: { _, _ in await probe.run() },
            disabler: { _ in initial }
        )

        let operation = Task {
            await store.configure(newPassword: "first secure password", currentPassword: nil)
        }
        await probe.waitUntilStarted()
        store.cancelRemoteOperations()
        await probe.release(with: Self.status(eligible: true, enabled: true))
        let accepted = await operation.value
        XCTAssertFalse(accepted)

        XCTAssertEqual(store.status, initial)
        XCTAssertEqual(store.mutationState, .idle)
    }

    private nonisolated static func status(eligible: Bool, enabled: Bool) -> PhonePasswordStatus {
        PhonePasswordStatus(response: APIPhonePasswordStatus(eligible: eligible, enabled: enabled))
    }
}

private actor PhonePasswordSettingsProbe {
    struct Snapshot: Sendable {
        let configurations: [(password: String, current: String?)]
        let disabledWith: [String]
    }

    private var configurations: [(password: String, current: String?)] = []
    private var disabledWith: [String] = []

    func recordConfiguration(password: String, current: String?) {
        configurations.append((password, current))
    }

    func recordDisable(current: String) {
        disabledWith.append(current)
    }

    var snapshot: Snapshot {
        Snapshot(configurations: configurations, disabledWith: disabledWith)
    }
}

private actor PhonePasswordFailureProbe {
    private var first = true

    func shouldFail() -> Bool {
        defer { first = false }
        return first
    }
}

private actor SuspendedPhonePasswordMutation {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var resultWaiters: [CheckedContinuation<PhonePasswordStatus, Never>] = []

    func run() async -> PhonePasswordStatus {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        return await withCheckedContinuation { resultWaiters.append($0) }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release(with status: PhonePasswordStatus) {
        resultWaiters.forEach { $0.resume(returning: status) }
        resultWaiters.removeAll()
    }
}
