import LuxoraKit
import SwiftUI
import UIKit
import UserNotifications

@main
@MainActor
struct LuxoraMobileApp: App {
    @UIApplicationDelegateAdaptor(LuxoraMobileAppDelegate.self) private var applicationDelegate
    @State private var session: ApplicationSession

    #if DEBUG
    private let debugAutomation: DebugLaunchAutomation?
    #endif

    init() {
        let session = ApplicationSession(configuration: .development)
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["LUXORA_UI_TEST_RESET_SESSION"] == "1" {
            session.resetPersistedSessionForUITestLaunch()
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
                .task {
                    await applicationDelegate.attach(to: session)
                }
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

@MainActor
private final class LuxoraMobileAppDelegate: NSObject, UIApplicationDelegate,
    UNUserNotificationCenterDelegate
{
    private weak var session: ApplicationSession?
    private var latestDeviceToken: Data?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func attach(to session: ApplicationSession) async {
        self.session = session
        if let latestDeviceToken {
            await session.receiveAPNSDeviceToken(latestDeviceToken, environment: pushEnvironment)
        }
        await synchronizeSystemAuthorization()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        Task { @MainActor [weak self] in
            await self?.synchronizeSystemAuthorization()
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        latestDeviceToken = deviceToken
        guard let session else { return }
        Task { @MainActor in
            await session.receiveAPNSDeviceToken(deviceToken, environment: pushEnvironment)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // The error can contain environment-specific details and is deliberately
        // not logged. The Russian retry state is enough for the user.
        session?.recordAPNSRegistrationFailure()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    private func synchronizeSystemAuthorization() async {
        guard let session else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            await session.synchronizePushAuthorization(isAuthorized: true)
            UIApplication.shared.registerForRemoteNotifications()
        case .denied:
            latestDeviceToken = nil
            await session.synchronizePushAuthorization(isAuthorized: false)
        case .notDetermined:
            break
        @unknown default:
            latestDeviceToken = nil
            await session.synchronizePushAuthorization(isAuthorized: false)
        }
    }

    private var pushEnvironment: APNSPushEnvironment {
        .currentApplicationBuild
    }
}
