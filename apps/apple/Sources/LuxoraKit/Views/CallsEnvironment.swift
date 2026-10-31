import SwiftUI

private struct CallsStoreEnvironmentKey: EnvironmentKey {
    static let defaultValue: CallsStore? = nil
}

extension EnvironmentValues {
    /// Calls store for the signed-in session. Nil when no session is active, so
    /// views degrade to the gated state instead of showing a fake call.
    var callsStore: CallsStore? {
        get { self[CallsStoreEnvironmentKey.self] }
        set { self[CallsStoreEnvironmentKey.self] = newValue }
    }
}
