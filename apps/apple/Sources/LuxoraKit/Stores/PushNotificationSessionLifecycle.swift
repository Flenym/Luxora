import Foundation

/// Orders the process-wide APNs token and the account-scoped server session.
///
/// Apple may deliver a token before session restoration finishes, or a session
/// may become ready before iOS has granted permission. Keeping that ordering in
/// one main-actor object also gives sign-out and account replacement a single
/// cancellation fence.
@MainActor
final class PushNotificationSessionLifecycle {
    private struct PendingRegistration: Sendable {
        let deviceToken: Data
        let environment: APNSPushEnvironment
    }

    private var pendingRegistration: PendingRegistration?
    private var authorizationAllowed: Bool?
    private weak var store: PushRegistrationStore?

    func attach(_ store: PushRegistrationStore) {
        guard self.store !== store else { return }
        self.store?.cancelRemoteOperations()
        self.store = store
    }

    /// Detaches the account-scoped store while intentionally retaining Apple's
    /// app/device token in memory. A later account can bind that same token only
    /// after its own authenticated store is attached.
    func detach() {
        store?.cancelRemoteOperations()
        store = nil
    }

    func receive(
        deviceToken: Data,
        environment: APNSPushEnvironment
    ) async {
        guard authorizationAllowed != false,
              (16...512).contains(deviceToken.count)
        else { return }

        let pending = PendingRegistration(
            deviceToken: deviceToken,
            environment: environment
        )
        pendingRegistration = pending
        guard let attachedStore = store else { return }
        _ = await attachedStore.register(
            deviceToken: pending.deviceToken,
            environment: pending.environment
        )
    }

    func synchronizeAuthorization(isAuthorized: Bool) async {
        authorizationAllowed = isAuthorized
        if isAuthorized {
            guard let pendingRegistration, let attachedStore = store else { return }
            _ = await attachedStore.register(
                deviceToken: pendingRegistration.deviceToken,
                environment: pendingRegistration.environment
            )
            return
        }

        pendingRegistration = nil
        guard let attachedStore = store else { return }
        _ = await attachedStore.unregister()
    }

    /// Reconciles the newly attached account after authentication bootstrap.
    /// The identity check prevents a late result from driving a replacement
    /// session; the detached store independently fences its own late response.
    func synchronizeAttachedStore() async {
        guard let attachedStore = store else { return }

        if authorizationAllowed == false {
            _ = await attachedStore.unregister()
        } else if let pendingRegistration {
            _ = await attachedStore.register(
                deviceToken: pendingRegistration.deviceToken,
                environment: pendingRegistration.environment
            )
        } else {
            await attachedStore.refresh()
        }

        guard store === attachedStore else { return }
    }

    func recordSystemRegistrationFailure() {
        store?.recordSystemRegistrationFailure()
    }
}
