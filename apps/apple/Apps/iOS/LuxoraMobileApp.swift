import LuxoraKit
import SwiftUI

@main
@MainActor
struct LuxoraMobileApp: App {
    @State private var session: ApplicationSession

    #if DEBUG
    private let debugAutomation: DebugLaunchAutomation?
    #endif

    init() {
        let session = ApplicationSession(configuration: .development)
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["LUXORA_UI_TEST_RESET_SESSION"] == "1" {
            session.discardRestoredSession()
        }
        if environment["LUXORA_UI_TEST_SCENARIO"] == "messenger" {
            session.installDebugUITestMessengerScenario()
        }
        debugAutomation = DebugLaunchAutomation(environment: environment)
        #endif
        _session = State(initialValue: session)
    }

    var body: some Scene {
        WindowGroup {
            LuxoraApplicationView(session: session)
                .tint(LuxoraTheme.accent)
                #if DEBUG
                .task {
                    await runDebugAutomationIfRequested()
                }
                #endif
        }
    }

    #if DEBUG
    @MainActor
    private func runDebugAutomationIfRequested() async {
        guard let debugAutomation else { return }

        // LuxoraApplicationView owns restoration. Wait for that single source
        // of truth instead of racing a second restore against it.
        while session.phase == .restoring {
            do {
                try await Task.sleep(for: .milliseconds(50))
            } catch {
                return
            }
        }

        guard session.phase == .unauthenticated else { return }
        await session.login(
            username: debugAutomation.username,
            password: debugAutomation.password
        )
    }
    #endif
}
